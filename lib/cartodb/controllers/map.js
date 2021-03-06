var _ = require('underscore');
var assert = require('assert');
var step = require('step');
var windshaft = require('windshaft');
var QueryTables = require('cartodb-query-tables');

var util = require('util');
var BaseController = require('./base');

var cors = require('../middleware/cors');
var userMiddleware = require('../middleware/user');

var MapConfig = windshaft.model.MapConfig;
var Datasource = windshaft.model.Datasource;

var NamedMapsCacheEntry = require('../cache/model/named_maps_entry');

var NamedMapMapConfigProvider = require('../models/mapconfig/provider/named-map-provider');
var CreateLayergroupMapConfigProvider = require('../models/mapconfig/provider/create-layergroup-provider');

/**
 * @param {AuthApi} authApi
 * @param {PgConnection} pgConnection
 * @param {TemplateMaps} templateMaps
 * @param {MapBackend} mapBackend
 * @param metadataBackend
 * @param {SurrogateKeysCache} surrogateKeysCache
 * @param {UserLimitsApi} userLimitsApi
 * @param {LayergroupAffectedTables} layergroupAffectedTables
 * @param {MapConfigAdapter} mapConfigAdapter
 * @constructor
 */
function MapController(authApi, pgConnection, templateMaps, mapBackend, metadataBackend,
                       surrogateKeysCache, userLimitsApi, layergroupAffectedTables, mapConfigAdapter) {

    BaseController.call(this, authApi, pgConnection);

    this.pgConnection = pgConnection;
    this.templateMaps = templateMaps;
    this.mapBackend = mapBackend;
    this.metadataBackend = metadataBackend;
    this.surrogateKeysCache = surrogateKeysCache;
    this.userLimitsApi = userLimitsApi;
    this.layergroupAffectedTables = layergroupAffectedTables;

    this.mapConfigAdapter = mapConfigAdapter;
}

util.inherits(MapController, BaseController);

module.exports = MapController;


MapController.prototype.register = function(app) {
    app.get(app.base_url_mapconfig, cors(), userMiddleware, this.createGet.bind(this));
    app.post(app.base_url_mapconfig, cors(), userMiddleware, this.createPost.bind(this));
    app.get(app.base_url_templated + '/:template_id/jsonp', cors(), userMiddleware, this.jsonp.bind(this));
    app.post(app.base_url_templated + '/:template_id', cors(), userMiddleware, this.instantiate.bind(this));
    app.options(app.base_url_mapconfig, cors('Content-Type'));
};

MapController.prototype.createGet = function(req, res){
    req.profiler.start('windshaft.createmap_get');

    this.create(req, res, function createGet$prepareConfig(err, req) {
        assert.ifError(err);
        if ( ! req.params.config ) {
            throw new Error('layergroup GET needs a "config" parameter');
        }
        return JSON.parse(req.params.config);
    });
};

MapController.prototype.createPost = function(req, res) {
    req.profiler.start('windshaft.createmap_post');

    this.create(req, res, function createPost$prepareConfig(err, req) {
        assert.ifError(err);
        if (!req.is('application/json')) {
            throw new Error('layergroup POST data must be of type application/json');
        }
        return req.body;
    });
};

MapController.prototype.instantiate = function(req, res) {
    if (req.profiler) {
        req.profiler.start('windshaft-cartodb.instance_template_post');
    }

    this.instantiateTemplate(req, res, function prepareTemplateParams(callback) {
        if (!req.is('application/json')) {
            return callback(new Error('Template POST data must be of type application/json'));
        }
        return callback(null, req.body);
    });
};

MapController.prototype.jsonp = function(req, res) {
    if (req.profiler) {
        req.profiler.start('windshaft-cartodb.instance_template_get');
    }

    this.instantiateTemplate(req, res, function prepareJsonTemplateParams(callback) {
        var err = null;
        if ( req.query.callback === undefined || req.query.callback.length === 0) {
            err = new Error('callback parameter should be present and be a function name');
        }

        var templateParams = {};
        if (req.query.config) {
            try {
                templateParams = JSON.parse(req.query.config);
            } catch(e) {
                err = new Error('Invalid config parameter, should be a valid JSON');
            }
        }

        return callback(err, templateParams);
    });
};

MapController.prototype.create = function(req, res, prepareConfigFn) {
    var self = this;

    var mapConfig;

    var context = {};

    step(
        function setupParams(){
            self.req2params(req, this);
        },
        prepareConfigFn,
        function prepareAdapterMapConfig(err, requestMapConfig) {
            assert.ifError(err);
            context.analysisConfiguration = {
                db: {
                    host: req.params.dbhost,
                    port: req.params.dbport,
                    dbname: req.params.dbname,
                    user: req.params.dbuser,
                    pass: req.params.dbpassword
                },
                batch: {
                    username: req.context.user,
                    apiKey: req.params.api_key
                }
            };
            self.mapConfigAdapter.getMapConfig(req.context.user, requestMapConfig, req.params, context, this);
        },
        function createLayergroup(err, requestMapConfig) {
            assert.ifError(err);
            var datasource = context.datasource || Datasource.EmptyDatasource();
            mapConfig = new MapConfig(requestMapConfig, datasource);
            self.mapBackend.createLayergroup(
                mapConfig, req.params,
                new CreateLayergroupMapConfigProvider(mapConfig, req.context.user, self.userLimitsApi, req.params),
                this
            );
        },
        function afterLayergroupCreate(err, layergroup) {
            assert.ifError(err);
            self.afterLayergroupCreate(req, res, mapConfig, layergroup, context.analysesResults, this);
        },
        function finish(err, layergroup) {
            if (err) {
                self.sendError(req, res, err, 'ANONYMOUS LAYERGROUP');
            } else {
                var analysesResults = context.analysesResults || [];
                addDataviewsAndWidgetsUrls(req.context.user, layergroup, mapConfig.obj());
                addAnalysesMetadata(req.context.user, layergroup, analysesResults, true);
                res.set('X-Layergroup-Id', layergroup.layergroupid);
                self.send(req, res, layergroup, 200);
            }
        }
    );
};

MapController.prototype.instantiateTemplate = function(req, res, prepareParamsFn) {
    var self = this;

    var cdbuser = req.context.user;

    var mapConfigProvider;
    var mapConfig;

    step(
        function setupParams(){
            self.req2params(req, this);
        },
        function getTemplateParams() {
            prepareParamsFn(this);
        },
        function getTemplate(err, templateParams) {
            assert.ifError(err);
            mapConfigProvider = new NamedMapMapConfigProvider(
                self.templateMaps,
                self.pgConnection,
                self.metadataBackend,
                self.userLimitsApi,
                self.mapConfigAdapter,
                cdbuser,
                req.params.template_id,
                templateParams,
                req.query.auth_token,
                req.params
            );
            mapConfigProvider.getMapConfig(this);
        },
        function createLayergroup(err, mapConfig_, rendererParams) {
            assert.ifError(err);
            mapConfig = mapConfig_;
            self.mapBackend.createLayergroup(
                mapConfig, rendererParams,
                new CreateLayergroupMapConfigProvider(mapConfig, cdbuser, self.userLimitsApi, rendererParams),
                this
            );
        },
        function afterLayergroupCreate(err, layergroup) {
            assert.ifError(err);
            self.afterLayergroupCreate(req, res, mapConfig, layergroup, mapConfigProvider.analysesResults, this);
        },
        function finishTemplateInstantiation(err, layergroup) {
            if (err) {
                self.sendError(req, res, err, 'NAMED MAP LAYERGROUP');
            } else {
                var templateHash = self.templateMaps.fingerPrint(mapConfigProvider.template).substring(0, 8);
                layergroup.layergroupid = cdbuser + '@' + templateHash + '@' + layergroup.layergroupid;

                addDataviewsAndWidgetsUrls(cdbuser, layergroup, mapConfig.obj());
                addAnalysesMetadata(cdbuser, layergroup, mapConfigProvider.analysesResults);

                res.set('X-Layergroup-Id', layergroup.layergroupid);
                self.surrogateKeysCache.tag(res, new NamedMapsCacheEntry(cdbuser, mapConfigProvider.getTemplateName()));

                self.send(req, res, layergroup, 200);
            }
        }
    );
};

MapController.prototype.afterLayergroupCreate = function(req, res, mapconfig, layergroup, analysesResults, callback) {
    var self = this;

    var username = req.context.user;

    var tasksleft = 2; // redis key and affectedTables
    var errors = [];

    var done = function(err) {
        if ( err ) {
            errors.push('' + err);
        }
        if ( ! --tasksleft ) {
            err = errors.length ? new Error(errors.join('\n')) : null;
            callback(err, layergroup);
        }
    };

    // include in layergroup response the variables in serverMedata
    // those variables are useful to send to the client information
    // about how to reach this server or information about it
    _.extend(layergroup, global.environment.serverMetadata);

    // Don't wait for the mapview count increment to
    // take place before proceeding. Error will be logged
    // asynchronously
    this.metadataBackend.incMapviewCount(username, mapconfig.obj().stat_tag, function(err) {
        if (req.profiler) {
            req.profiler.done('incMapviewCount');
        }
        if ( err ) {
            global.logger.log("ERROR: failed to increment mapview count for user '" + username + "': " + err);
        }
        done();
    });

    var sql = mapconfig.getLayers().map(function(layer) {
        return layer.options.sql;
    }).join(';');

    var dbName = req.params.dbname;
    var layergroupId = layergroup.layergroupid;

    step(
        function getPgConnection() {
            self.pgConnection.getConnection(username, this);
        },
        function getAffectedTablesAndLastUpdatedTime(err, connection) {
            assert.ifError(err);
            QueryTables.getAffectedTablesFromQuery(connection, sql, this);
        },
        function handleAffectedTablesAndLastUpdatedTime(err, result) {
            if (req.profiler) {
                req.profiler.done('queryTablesAndLastUpdated');
            }
            assert.ifError(err);
            // feed affected tables cache so it can be reused from, for instance, layergroup controller
            self.layergroupAffectedTables.set(dbName, layergroupId, result);

            var lastUpdateTime = result.getLastUpdatedAt();
            lastUpdateTime = getLastUpdatedTime(analysesResults, lastUpdateTime) || lastUpdateTime;

            // last update for layergroup cache buster
            layergroup.layergroupid = layergroup.layergroupid + ':' + lastUpdateTime;
            layergroup.last_updated = new Date(lastUpdateTime).toISOString();

            if (req.method === 'GET') {
                var ttl = global.environment.varnish.layergroupTtl || 86400;
                res.set('Cache-Control', 'public,max-age='+ttl+',must-revalidate');
                res.set('Last-Modified', (new Date()).toUTCString());
                res.set('X-Cache-Channel', result.getCacheChannel());
                if (result.tables && result.tables.length > 0) {
                    self.surrogateKeysCache.tag(res, result);
                }
            }

            return null;
        },
        function finish(err) {
            done(err);
        }
    );
};

function getLastUpdatedTime(analysesResults, lastUpdateTime) {
    if (!Array.isArray(analysesResults)) {
        return lastUpdateTime;
    }
    return analysesResults.reduce(function(lastUpdateTime, analysis) {
        return analysis.getSortedNodes().reduce(function(lastNodeUpdatedAtTime, node) {
            var nodeUpdatedAtDate = node.getUpdatedAt();
            var nodeUpdatedTimeAt = (nodeUpdatedAtDate && nodeUpdatedAtDate.getTime()) || 0;
            return nodeUpdatedTimeAt > lastNodeUpdatedAtTime ? nodeUpdatedTimeAt : lastNodeUpdatedAtTime;
        }, lastUpdateTime);
    }, lastUpdateTime);
}

function addAnalysesMetadata(username, layergroup, analysesResults, includeQuery) {
    includeQuery = includeQuery || false;
    analysesResults = analysesResults || [];
    layergroup.metadata.analyses = [];

    analysesResults.forEach(function(analysis) {
        var nodes = analysis.getSortedNodes();
        layergroup.metadata.analyses.push({
            nodes: nodes.reduce(function(nodesIdMap, node) {
                if (node.params.id) {
                    var nodeResource = layergroup.layergroupid + '/analysis/node/' + node.id();
                    nodesIdMap[node.params.id] = {
                        status: node.getStatus(),
                        url: getUrls(username, nodeResource)
                    };
                    if (includeQuery) {
                        nodesIdMap[node.params.id].query = node.getQuery();
                    }
                }

                return nodesIdMap;
            }, {})
        });
    });
}

// TODO this should take into account several URL patterns
function addDataviewsAndWidgetsUrls(username, layergroup, mapConfig) {
    addDataviewsUrls(username, layergroup, mapConfig);
    addWidgetsUrl(username, layergroup, mapConfig);
}

function addDataviewsUrls(username, layergroup, mapConfig) {
    layergroup.metadata.dataviews = layergroup.metadata.dataviews || {};
    var dataviews = mapConfig.dataviews || {};

    Object.keys(dataviews).forEach(function(dataviewName) {
        var resource = layergroup.layergroupid + '/dataview/' + dataviewName;
        layergroup.metadata.dataviews[dataviewName] = {
            url: getUrls(username, resource)
        };
    });
}

function addWidgetsUrl(username, layergroup, mapConfig) {
    if (layergroup.metadata && Array.isArray(layergroup.metadata.layers) && Array.isArray(mapConfig.layers)) {
        layergroup.metadata.layers = layergroup.metadata.layers.map(function(layer, layerIndex) {
            var mapConfigLayer = mapConfig.layers[layerIndex];
            if (mapConfigLayer.options && mapConfigLayer.options.widgets) {
                layer.widgets = layer.widgets || {};
                Object.keys(mapConfigLayer.options.widgets).forEach(function(widgetName) {
                    var resource = layergroup.layergroupid + '/' + layerIndex + '/widget/' + widgetName;
                    layer.widgets[widgetName] = {
                        type: mapConfigLayer.options.widgets[widgetName].type,
                        url: getUrls(username, resource)
                    };
                });
            }
            return layer;
        });
    }
}

function getUrls(username, resource) {
    var cdnUrl = global.environment.serverMetadata && global.environment.serverMetadata.cdn_url;
    if (cdnUrl) {
        return {
            http: 'http://' + cdnUrl.http + '/' + username + '/api/v1/map/' + resource,
            https: 'https://' + cdnUrl.https + '/' + username + '/api/v1/map/' + resource
        };
    } else {
        var port = global.environment.port;
        return {
            http: 'http://' + username + '.' + 'localhost.lan:' + port +  '/api/v1/map/' + resource
        };
    }
}

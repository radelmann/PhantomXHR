var require = patchRequire(require);

exports.init = phantomXHRInit;
exports.fake = fake;
exports.requests = getAllRequests;
exports.completed = allRequestsCompleted;
exports.clearfakes = clearfakes;

var page;

function phantomXHRInit(initPage, options){
	var inject = false;

	options = options || {};

	if(initPage.injectJs){

		initPage.evaluate(function(){
			// Shim these constructors to make progress events work in PhantomJS
			window.ProgressEvent = function(){};
			window.CustomEvent = function(){};
		});

		inject = initPage.injectJs(options.libraryRoot ? (fs.absolute(options.libraryRoot) + 'sinon.js') : './node_modules/phantomxhr/sinon.js');

		initPage.evaluate(function(){

			// A naive implementation for simulating upload events
			function FakeEvent(type, bubbles, cancelable, target) {
				this.initEvent(type, bubbles, cancelable, target);
			}

			FakeEvent.prototype = {
				initEvent: function(type, event, cancelable, target) {
					var key;

					this.type = type;
					this.bubbles = event;
					this.lengthComputable = true;
					this.isTrusted = true;
					this.cancelable = cancelable;
					this.target = target;
					this.loaded = 0;
					this.total = 0;

					for ( key in event ){
						this[key] = event[key];
					}
				},
				stopPropagation: function () {},
				stopImmediatePropagation: function () {},
				preventDefault: function () {
					this.defaultPrevented = true;
				}
			};

			window.ProgressEvent = FakeEvent;
			window.CustomEvent = FakeEvent;
		});

	}

	if(inject){
		page = initPage;
		setup(options);
	} else {
		console.log("[PhantomXHR] Can't find sinon.js");
	}
}

function setup(options){
	page.evaluate(function (options) {

		if (!window._ajaxmock_) {
			window._ajaxmock_ = {
				matches: [],
				requests_created: 0,
				requests_completed: 0,
				requests: {},
				call: {},
				fake: function (match) {
					match.delay = match.delay || 1;

					function s4() {
						return (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1);
					}

					function makeGuid() {
						return (s4() + s4() + "-" + s4() + "-" + s4() + "-" + s4() + "-" + s4() + s4() + s4());
					}

					var urlIsString = match.url.indexOf('REGEXP') === -1;
					var guid = makeGuid();

					match.guid = guid;
					match.url = match.url.replace('REGEXP', '');

					console.log('[PhantomXHR] Match added [' + (match.method || 'All REST verbs') + "] : " + match.url + "'");

					match.requests = [];
					match.responses = [];
					match.respondMethods = [];

					window._ajaxmock_.call[guid] = match;

					window._ajaxmock_.matches.push(function (method, url) {

						if (!url) {
							return false;
						}

						var urlMatch = urlIsString ? url.indexOf(match.url) !== -1 : new RegExp(match.url).test(url);
						var methodMatch = (typeof match.method === 'undefined') ? true : match.method.toLowerCase() === method.toLowerCase();

						if (urlMatch && methodMatch) {
							return match;
						} else {
							return false;
						}
					});

					return guid;
				},
				init: function () {
					var _xhr = window.sinon.useFakeXMLHttpRequest();

					// overrideMimeType is not mocked see this issue
					// https://github.com/cjohansen/Sinon.JS/issues/559
					window.sinon.FakeXMLHttpRequest.prototype.overrideMimeType = function(){};

					// we backup _xhr object
					window.backup_xhr = _xhr;

					// If need create real XHR (by default false)
					if (options.allowRealRequests) {
						_xhr.useFilters = true;
						_xhr.addFilter(function(method, url) {
							var anyMatches = false;
							window._ajaxmock_.matches.slice(0).reverse().forEach(function (func) {
								anyMatches = anyMatches || func(method, url);
							});
							return !anyMatches;
						});
					}

					_xhr.upload = document.createElement('div');

					_xhr.onCreate = function (request) {

						window._ajaxmock_.requests_created++;
						setTimeout(function () {
							var anyMatches = false;
							var requests = window._ajaxmock_.requests;

							if (!request.url) {
								console.log('[PhantomXHR] XHR has been initialised but not opened.');
								return;
							} // this shouldn't happen, but sometimes does
							// store the request for later matching
							if (requests[request.method.toLowerCase() + request.url]) {
								requests[request.method.toLowerCase() + request.url].count++;
							} else {
								requests[request.method.toLowerCase() + request.url] = {
									data: request,
									count: 1
								};
							}

							window._ajaxmock_.matches.slice(0).reverse().forEach(function (func) {
								anyMatches = anyMatches || func(request.method, request.url);
							});

							if (anyMatches) {
								respond(request, anyMatches);
							} else {
								console.log('[PhantomXHR] did not respond to ' + request.method + ' ' + request.url);
								window._ajaxmock_.requests_completed++;
							}
						}, 100);
					};
				}
			};
			window._ajaxmock_.init();
		}

		function respond(request, response) {
			if(!window._ajaxmock_){
				console.log('[PhantomXHR] could not respond, window._ajaxmock_ does not exist.');
				return;
			}

			var call = window._ajaxmock_.call;
			var callForThisMatch;
			var responseForThisMatch;
			var status;
			var body;

			function doRespond(response){
				if(response.networkUnavailable){
					request.status = 0;
					request.statusText = 'timeout';
					request.abort();
					return;
				}

				setTimeout(function() {
					console.log('waiting ' + response.delay + ' milliseconds before responding.');
					
					request.respond(
						status || response.status || 200, response.headers || {
							"Content-Type": "application/json"
						},
						body || response.responseBody || ''
					);	
				}, response.delay);

				window._ajaxmock_.requests_completed++;
			}

			console.log('[PhantomXHR] received request for ' + request.method + ": " + request.url + "'");

			callForThisMatch = call[response.guid];

			responseForThisMatch = callForThisMatch.responses[callForThisMatch.requests.length];

			callForThisMatch.requests.push(request);

			if (responseForThisMatch) {
				status = responseForThisMatch.status;
				body = responseForThisMatch.responseBody;
			}

			console.log('[PhantomXHR] with status: ' +  status || response.status || 200);

			if(response.holdResponse){

				callForThisMatch.respondMethods.push(function(responseOverride){
					responseOverride = responseOverride || response;
					console.log('[PhantomXHR] Responding to postponed ' + request.method + ": " + request.url + "'");
					doRespond(responseOverride);
				});

			} else {
				console.log('[PhantomXHR] Responding to ' + request.method + ": " + request.url + "'");
				doRespond(response);
			}

		}
	}, options);
}

function fake(options) {
	var url = !! options.url.source ? 'REGEXP' + options.url.source : options.url;

	if(typeof(options.responseBody) === "object"){
		options.responseBody = JSON.stringify(options.responseBody);
	}

	var guid = page.evaluate(function (url, method, responseBody, status, headers, holdResponse, delay) {
		if (window._ajaxmock_ && url) {

			if (responseBody && headers && headers["Content-Type"] && headers["Content-Type"] === "application/json") {
				try {
					JSON.parse(responseBody);
				} catch (e) {
					return 'JSON';
				}
			}

			console.log("[PhantomXHR] Sending mock response for " + url);

			return window._ajaxmock_.fake({
				url: url,
				method: method,
				responseBody: responseBody,
				status: status,
				headers: headers,
				holdResponse: holdResponse,
				delay: delay
			});
		}
	}, url, options.method, options.responseBody, options.status, options.headers, !!options.holdResponse, options.delay);

	if (guid === 'JSON') {
		console.log('[PhantomXHR] JSON was invalid : ' + options.method + ' : ' + url);
	}

	return {
		count: function () {
			var c = page.evaluate(function (guid) {
				if( !(window._ajaxmock_ && window._ajaxmock_.call[guid] )){
					return;
				}
				return window._ajaxmock_.call[guid].requests.length;
			}, guid);

			if(typeof c === 'undefined'){
				console.log('[PhantomXHR] Could not get count');
			}

			return c;
		},

		nthRequest: function (index) {
			var r = page.evaluate(function (guid, index) {
				if( !(window._ajaxmock_ && window._ajaxmock_.call[guid] )){
					return;
				}
				var request = window._ajaxmock_.call[guid].requests[index - 1];
				return request.requestBody;
			}, guid, index);

			if(typeof r === 'undefined'){
				console.log('[PhantomXHR] Could not get request');
			}

			return r;
		},

		nthRequestOrNull: function (index) {
			var r = page.evaluate(function (guid, index) {
				if( !(window._ajaxmock_ && window._ajaxmock_.call[guid] )){
					return;
				}
				var request = window._ajaxmock_.call[guid].requests[index - 1];
				if (!request) { return null; }
				return request;
			}, guid, index);

			if(typeof r === 'undefined'){
				console.log('[PhantomXHR] Could not get request');
			}

			return r;
		},

		last: function () {
			var last = page.evaluate(function (guid) {
				return window._ajaxmock_.call[guid].requests.length;
			}, guid);

			return this.nthRequest(last);
		},

		first: function () {
			return this.nthRequest(1);
		},

		firstOrNull: function () {
			return this.nthRequestOrNull(1);
		},

		nthRequestHeader: function (index, key) {
			var r = page.evaluate(function (guid, index) {
				if( !(window._ajaxmock_ && window._ajaxmock_.call[guid] )){
					return;
				}
				var request = window._ajaxmock_.call[guid].requests[index - 1];
				return request.requestHeaders;
			}, guid, index);

			if(typeof r === 'undefined'){
				console.log('[PhantomXHR] Could not get request');
			}

			return r ? r[key] : null;
		},

		lastRequestHeader: function (key) {
			var last = page.evaluate(function (guid) {
				return window._ajaxmock_.call[guid].requests.length;
			}, guid);

			return this.nthRequestHeader(last, key);
		},

		firstRequestHeader: function (key) {
			return this.nthRequestHeader(1, key);
		},

		nthResponse: function (num, response) {
			var r = page.evaluate(function (guid, num, response) {
				if (typeof(response.responseBody) === "object") {
					response.responseBody = JSON.stringify(response.responseBody);
				}
				if( !(window._ajaxmock_ && window._ajaxmock_.call[guid] )){
					return;
				}
				window._ajaxmock_.call[guid].responses[num-1] = response;
				return true;
			}, guid, num, response );

			if(typeof r === 'undefined'){
				console.log('[PhantomXHR] Could not set response');
			}

			return this;
		},

		nthProgress: function(nth, event){

			function isNumber(n) {
				return !isNaN(parseFloat(n)) && isFinite(n);
			}

			if( isNumber(event.loaded) && isNumber(event.total) ){
				page.evaluate(function (guid, nth, event) {
					var mock = window._ajaxmock_;
					var req;

					if( !(mock && mock.call[guid]) ){
						return;
					}

					req = mock.call[guid].requests[nth-1];

					if(req){
						req.uploadProgress(event);
					}

				}, guid, nth, event);
			} else {
				console.log('[PhantomXHR] Could not set progress');
			}
		},

		restore: function(){
			page.evaluate(function(){
				window.backup_xhr.restore();
			});
		},

		nthRespond: function(nth, response){
			// if you don't want to respond immediately

			page.evaluate(function (guid, nth, response) {
				var placeholder = 'placeholder';
				var si;
				var item;

				function processResponse(){
					var res;
					var method;
					var item = window._ajaxmock_.call[guid];
					var queue = item.queuedResponses;

					if(queue && item.respondMethods.length){

						res = queue[nth-1];
						method = item.respondMethods[nth-1];
						if(method){
							method(res === placeholder ? void 0 : res);
						}

						if(si) {
							clearInterval(si);
						}

						return true;
					}
					return false;
				}

				response =  response || placeholder;

				if( !(window._ajaxmock_ && window._ajaxmock_.call[guid] )){
					return;
				}

				item = window._ajaxmock_.call[guid];

				if(!item.queuedResponses) {
					item.queuedResponses = [];
				}

				item.queuedResponses.push(response);

				if(!processResponse()){
					si = setInterval(processResponse,50);
				}

			}, guid, nth, response);
		},

		respond: function(response){
			var last = page.evaluate(function (guid) {
				var c = window._ajaxmock_.call[guid]._countRespondRequests;
				if(c){
					c+=1;
				} else {
					c=1;
				}
				window._ajaxmock_.call[guid]._countRespondRequests = c;
				return c;
			}, guid);

			return this.nthRespond(last, response);
		},

		progress: function(event){

			var last = page.evaluate(function (guid) {
				var c = window._ajaxmock_.call[guid]._countProgressRequests;
				if(c){
					c+=1;
				} else {
					c=1;
				}
				window._ajaxmock_.call[guid]._countProgressRequests = c;
				return c;
			}, guid);

			return this.nthProgress(last, event);
		},

		unHold: function(){
			page.evaluate(function (guid) {
				if( !(window._ajaxmock_ && window._ajaxmock_.call[guid] )){
					return;
				}
				window._ajaxmock_.call[guid].holdResponse = false;
			}, guid);
		},

		hold: function(){
			page.evaluate(function (guid) {
				if( !(window._ajaxmock_ && window._ajaxmock_.call[guid] )){
					return;
				}
				window._ajaxmock_.call[guid].holdResponse = true;
			}, guid);
		},

		uri: options.url,
		method: options.method
	};
}

function getAllRequests() {
	var requests = page.evaluate(function () {
		var requests = {};

		if (window._ajaxmock_) {
			requests = window._ajaxmock_.requests;
		}

		return requests;
	});

	return requests;
}

function allRequestsCompleted() {
	return page.evaluate(function () {

		if (window._ajaxmock_) {
			return window._ajaxmock_.requests_created === window._ajaxmock_.requests_completed;
		}

		return false;
	});
}

function clearfakes(){
	page.evaluate(function () {
		if (window._ajaxmock_) {
			window._ajaxmock_.matches = [];
		}
	});
}

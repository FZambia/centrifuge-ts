import {
    isFunction,
    isString,
    log,
    stripSlash,
    startsWith,
    endsWith,
    errorExists,
    objectToQuery,
} from './Functions';
import {Observable} from 'js-observable';
import {Subscription} from './Subscription';
import {proto} from './proto/client';

import {
    ISockJSOptions,
    ICentrifugeConfig,
    ICentrifugeError,
    ICentrifugeCredentials,
    ICentrifugeMessage,
    ICentrifugeConnectMessage,
    ICentrifugePingMessage,
    ICentrifugeSubscribeMessage,
    ICentrifugeUnsubscribeMessage,
    ICentrifugeRefreshMessage,
    ICentrifugeConnectResponse,
    ICentrifugeRefreshResponse,
    ICentrifugeSubscribeResponse,
    ICentrifugeUnsubscribeResponse,
    ICentrifugeJoinResponse,
    ICentrifugeLeaveResponse,
} from './interfaces';

export class Centrifuge extends Observable {

    private _config: ICentrifugeConfig = {};
    private _status = 'disconnected';
    private _isSockJS = false;
    private _transport: any = null;
    private _transportName: string = null;
    private _transportClosed = true;
    private _reconnect = true;
    private _reconnecting = false;
    private _numRefreshFailed = 0;
    private _refreshTimeout: any = null;
    private _pongTimeout: any = null;
    private _pingInterval: any = null;
    private _messageId = 0;
    private _messages: ICentrifugeMessage[] = [];
    private _isBatching = false;
    private _isAuthBatching = false;
    private _authChannels: any = {};
    private _clientID: string = null;
    private _callbacks: any = {};
    private _subs: any = {};
    private _retries = 0;
    private _latency: number = null;
    private _latencyStart: Date = null;
    private _lastMessageID: any = {};

    constructor(config: ICentrifugeConfig) {
        super();
        this._configure(config);
    }

    public get isConnected(): boolean {
        return this._status === 'connected';
    }

    public get isDisconnected(): boolean {
        return this._status === 'disconnected';
    }

    public connect(): void {
        if (this.isConnected) {
            this._debug('Connect called when already connected');
            return;
        }
        if (this._status === 'connecting') {
            return;
        }
        this._debug('Start connecting');
        this._setStatus('connecting');
        this._clientID = null;
        this._reconnect = true;
        this._setTransport();
    }

    public disconnect(): void {
        this._disconnect('client');
    }

    public ping(): void {
        this.addMessage(<ICentrifugePingMessage>{
            method: 'ping'
        }).then((response: any) => {
        }, (error: ICentrifugeError) => {
        });
    }

    public startBatching(): void {
        // start collecting messages without sending them to Centrifuge until flush method called
        this._isBatching = true;
    }

    public stopBatching(flush: boolean = false): void {
        // stop collecting messages
        this._isBatching = false;
        if (flush === true) {
            this.flush();
        }
    }

    public flush(): void {
        // send batched messages to Centrifuge
        const messages = [...this._messages];
        this._send(messages);
        this._messages = [];
    }

    public startAuthBatching(): void {
        // start collecting private channels to create bulk authentication
        // request to authEndpoint when stopAuthBatching will be called
        this._isAuthBatching = true;
    }

    public stopAuthBatching(): void {
        let i: string;
        let channel: string;

        // create request to authEndpoint with collected private channels
        // to ask if this client can subscribe on each channel
        this._isAuthBatching = false;
        const authChannels = [...this._authChannels];
        this._authChannels = {};
        const channels = [];

        for (channel in authChannels) {
            if (authChannels.hasOwnProperty(channel)) {
                if (!this._getSub(channel)) {
                    continue;
                }
                channels.push(channel);
            }
        }

        if (channels.length === 0) {
            return;
        }

        const cb = (err: boolean, _data: any) => {
            if (err === true) {
                this._debug('Authorization request failed');
                for (i in channels) {
                    if (channels.hasOwnProperty(i)) {
                        channel = channels[i];
                        this._subscribeError(<ICentrifugeError>{
                            error: 'authorization request failed',
                            advice: 'fix',
                            body: {
                                channel,
                            }
                        });
                    }
                }
                return;
            }

            // try to send all subscriptions in one request.
            let batch = false;
            if (!this._isBatching) {
                this.startBatching();
                batch = true;
            }

            for (i in channels) {
                if (channels.hasOwnProperty(i)) {
                    channel = channels[i];
                    const channelResponse = _data[channel];
                    if (!channelResponse) {
                        this._subscribeError(<ICentrifugeError>{
                            error: 'channel not found in authorization response',
                            advice: 'fix',
                            body: {
                                channel,
                            }
                        });
                        continue;
                    }
                    if (!channelResponse.status || channelResponse.status === 200) {
                        const msg = <ICentrifugeSubscribeMessage>{
                            method: 'subscribe',
                            params: {
                                channel: channel,
                                client: this._clientID,
                                info: channelResponse.info,
                                sign: channelResponse.sign
                            }
                        };
                        if (this._recover(channel) === true) {
                            msg.params.recover = true;
                            msg.params.last = this._getLastID(channel);
                        }
                        this.addMessage(msg).then((response: ICentrifugeSubscribeResponse) => {
                            this._subscribeResponse(response);
                        }, (error: ICentrifugeError) => {
                        });
                    } else {
                        this._subscribeError(<ICentrifugeError>{
                            error: channelResponse.status,
                            body: {
                                channel: channel
                            }
                        });
                    }
                }
            }

            if (batch) {
                this.stopBatching(true);
            }

        };

        const data = {
            client: this._clientID,
            channels,
        };

        if (isFunction(this._config.onPrivateChannelAuth)) {
            this._config.onPrivateChannelAuth({
                data,
            }, cb);
        } else {
            this._request(
                this._config.authEndpoint,
                this._config.authParams,
                this._config.authHeaders,
                data,
                cb
            );
        }
    }

    public subscribe(channel: string, events?: any): Subscription {
        if (!isString(channel)) {
            throw new Error('Illegal argument type: channel must be a string');
        }
        if (!this._config.resubscribe && !this.isConnected) {
            throw new Error('Can not only subscribe in connected state when resubscribe option is off');
        }

        const currentSub = this._getSub(channel);

        if (currentSub !== null) {
            currentSub.setEvents(events);
            if (currentSub.isUnsubscribed) {
                currentSub.subscribe();
            }
            return currentSub;
        } else {
            const sub = new Subscription(this, channel, events);
            this._subs[channel] = sub;
            sub.subscribe();
            return sub;
        }
    }

    public subscribeSub(sub: Subscription): void {
        const channel = sub.channel;

        if (!(channel in this._subs)) {
            this._subs[channel] = sub;
        }

        if (!this.isConnected) {
            // subscribe will be called later
            sub.setNew();
            return;
        }

        sub.setSubscribing();

        // If channel name does not start with privateChannelPrefix - then we
        // can just send subscription message to Centrifuge. If channel name
        // starts with privateChannelPrefix - then this is a private channel
        // and we should ask web application backend for permission first.
        if (startsWith(channel, this._config.privateChannelPrefix)) {
            // private channel
            if (this._isAuthBatching) {
                this._authChannels[channel] = true;
            } else {
                this.startAuthBatching();
                this.subscribeSub(sub);
                this.stopAuthBatching();
            }
        } else {
            const msg = <ICentrifugeSubscribeMessage>{
                method: 'subscribe',
                params: {
                    channel,
                }
            };
            if (this._recover(channel) === true) {
                msg.params.recover = true;
                msg.params.last = this._getLastID(channel);
            }
            this.addMessage(msg).then((response: ICentrifugeSubscribeResponse) => {
                this._subscribeResponse(response);
            }, (error: ICentrifugeError) => {
                this._subscribeError(error);
            });
        }
    }

    public unsubscribeSub(sub: Subscription): void {
        if (this.isConnected) {
            // No need to unsubscribe in disconnected state - i.e. client already unsubscribed.
            this.addMessage(<ICentrifugeUnsubscribeMessage>{
                method: 'unsubscribe',
                params: {
                    channel: sub.channel
                }
            }).then((response: ICentrifugeUnsubscribeResponse) => {
                this._unsubscribeResponse(response);
            }, (error: ICentrifugeError) => {
            });
        }
    }

    public addMessage(message: ICentrifugeMessage): Promise<any> {
        return new Promise((callback: Function, errback: Function) => {
            const uid = this._getNextMessageId() + '';
            message.uid = uid;
            if (this._isBatching === true) {
                this._messages.push(message);
            } else {
                this._send([message]);
            }
            this._callbacks[uid] = {
                callback,
                errback,
            };
            setTimeout(() => {
                delete this._callbacks[uid];
                if (isFunction(errback)) {
                    errback(Centrifuge.createErrorObject('timeout', 'retry'));
                }
            }, this._config.timeout);
        });
    }

    public static createErrorObject(error: string, advice?: string): ICentrifugeError {
        const result: ICentrifugeError = {
            error,
        };
        if (advice) {
            result.advice = advice;
        }
        return result;
    }

    public static log(...args: any[]): void {
        log('info', ...args);
    }

    public static error(...args: any[]): void {
        log('error', ...args);
    }

    private _debug(...args: any[]): void {
        if (this._config.debug === true) {
            log('debug', ...args);
        }
    }

    private _configure(config: ICentrifugeConfig): void {
        this._debug('Configuring Centrifuge with', config);
        config = Object.assign({
            retry: 1000,
            maxRetry: 20000,
            timeout: 5000,
            info: '',
            resubscribe: true,
            ping: true,
            pingInterval: 30000,
            pongWaitTimeout: 5000,
            debug: false,
            insecure: false,
            privateChannelPrefix: '$',
            refreshEndpoint: '/centrifuge/refresh/',
            refreshHeaders: {},
            refreshParams: {},
            refreshData: {},
            refreshAttempts: 0,
            refreshInterval: 3000,
            authEndpoint: '/centrifuge/auth/',
            authHeaders: {},
            authParams: {},
        }, config);

        if (!config.url) {
            throw new Error('Missing required configuration parameter \'url\' specifying server URL');
        }
        config.url = stripSlash(config.url);

        if (isFunction(config.sockJS)) {
            this._isSockJS = true;
            if (!config.transports || !config.transports.length) {
                config.transports = [
                    'websocket',
                    'xdr-streaming',
                    'xhr-streaming',
                    'eventsource',
                    'iframe-eventsource',
                    'iframe-htmlfile',
                    'xdr-polling',
                    'xhr-polling',
                    'iframe-xhr-polling',
                    'jsonp-polling'
                ];
            }
        } else {
            if (!isFunction(WebSocket)) {
                throw new Error('No Websocket support and no SockJS configured, can not connect');
            }
        }

        if (!config.user) {
            if (!config.insecure) {
                throw new Error('Missing required configuration parameter \'user\' specifying user\'s unique ID in your application');
            } else {
                this._debug('Configuration parameter \'user\' not found but this is OK for insecure mode - anonymous access will be used');
            }
        } else {
            if (!isString(config.user)) {
                Centrifuge.log('Configuration parameter \'user\' expected to be string');
            }
        }

        if (!config.time) {
            if (!config.insecure) {
                throw new Error('Missing required configuration parameter \'time\'');
            } else {
                this._debug('Configuration parameter \'time\' not found but this is OK for insecure mode');
            }
        } else {
            if (!isString(config.time)) {
                Centrifuge.log('Configuration parameter \'time\' expected to be string');
            }
        }

        if (!config.sign) {
            if (!config.insecure) {
                throw new Error('Missing required configuration parameter \'sign\' specifying the sign of authorization request');
            } else {
                this._debug('Configuration parameter \'sign\' not found but this is OK for insecure mode');
            }
        } else {
            if (!isString(config.sign)) {
                Centrifuge.log('Configuration parameter \'sign\' expected to be string');
            }
        }

        if (config.info && !isString(config.info)) {
            Centrifuge.log('Configuration parameter \'info\' expected to be string');
        }

        this._config = config;
    }

    private _request(url: string, params: any, headers: any, data: any, callback: Function): void {
        this._debug('Sending POST request to', url);
        let query = objectToQuery(params);
        if (query.length > 0) {
            query = '?' + query;
        }
        const _headers = new Headers();
        _headers.append('X-Requested-With', 'XMLHttpRequest');
        _headers.append('Content-Type', 'application/json');
        for (const headerName in headers) {
            if (headers.hasOwnProperty(headerName)) {
                _headers.append(headerName, headers[headerName]);
            }
        }
        fetch(url + query, {
            method: 'POST',
            headers: _headers,
            body: data,
            credentials: 'include',
            mode: 'cors',
        }).then((response: Response) => {
            if (response.ok) {
                return response.json();
            }
            Centrifuge.error('Network response was not ok', response.status);
        }).then((callbackData: any) => {
            callback(false, callbackData);
        }).catch((error: any) => {
            Centrifuge.error('Network response error', error);
        });
    }

    private _getSockjsEndpoint(): string {
        let url = this._config.url;
        url = url
            .replace('ws://', 'http://')
            .replace('wss://', 'https://');
        url = stripSlash(url);
        if (!endsWith(this._config.url, 'connection')) {
            url = url + '/connection';
        }
        return url;
    }

    private _getWebsocketEndpoint(): string {
        let url = this._config.url;
        url = url
            .replace('http://', 'ws://')
            .replace('https://', 'wss://');
        url = stripSlash(url);
        if (!endsWith(this._config.url, 'connection/websocket')) {
            url = url + '/connection/websocket';
        }
        return url;
    }

    private _recover(channel: string): boolean {
        return channel in this._lastMessageID;
    }

    private _getLastID(channel: string): string {
        const lastUID = this._lastMessageID[channel];
        if (lastUID) {
            this._debug('Last uid found and sent for channel', channel);
            return lastUID;
        } else {
            this._debug('No last uid found for channel', channel);
            return '';
        }
    }

    private _getSub(channel: string): Subscription {
        return this._subs[channel] || null;
    }

    private _clearConnectedState(reconnect: boolean): void {
        this._clientID = null;

        // fire errbacks of registered calls.
        for (const uid in this._callbacks) {
            if (this._callbacks.hasOwnProperty(uid)) {
                const callbacks = this._callbacks[uid];
                const errback = callbacks.errback;
                if (isFunction(errback)) {
                    errback(Centrifuge.createErrorObject('disconnected', 'retry'));
                }
            }
        }
        this._callbacks = {};

        // fire unsubscribe events
        for (const channel in this._subs) {
            if (this._subs.hasOwnProperty(channel)) {
                const sub = this._getSub(channel);
                if (reconnect) {
                    if (sub.isSuccess) {
                        sub.triggerUnsubscribe();
                    }
                    sub.setSubscribing();
                } else {
                    sub.setUnsubscribed();
                }
            }
        }

        if (!this._config.resubscribe || !this._reconnect) {
            // completely clear connected state
            this._subs = {};
        }
    }

    private _setStatus(status: string): void {
        if (this._status !== status) {
            this._debug('Status:', this._status, '->', status);
            this._status = status;
        }
    }

    private _disconnect(reason: string, shouldReconnect: boolean = false): void {
        if (this.isDisconnected) {
            return;
        }
        this._debug('Disconnected:', reason + '.', 'shouldReconnect:', shouldReconnect);

        if (shouldReconnect === false) {
            this._reconnect = false;
        }

        this._clearConnectedState(shouldReconnect);

        if (!this.isDisconnected) {
            this._setStatus('disconnected');
            if (this._refreshTimeout) {
                clearTimeout(this._refreshTimeout);
            }
            if (this._reconnecting === false) {
                this.trigger('disconnect', [{
                    reason,
                    reconnect: shouldReconnect,
                }]);
            }
        }

        if (!this._transportClosed) {
            this._transport.close();
        }
    }

    private _send(messages: ICentrifugeMessage[]): void {
        if (!messages.length) {
            return;
        }
        const encodedMessages = [];
        for (const i in messages) {
            if (messages.hasOwnProperty(i)) {
                encodedMessages.push(JSON.stringify(messages[i]));
            }
        }
        this._transport.send(encodedMessages.join("\n"));
        this._debug('Send', messages);
    }

    private _getNextMessageId(): number {
        return ++this._messageId;
    }

    private _stopPing(): void {
        if (this._pongTimeout !== null) {
            clearTimeout(this._pongTimeout);
        }
        if (this._pingInterval !== null) {
            clearInterval(this._pingInterval);
        }
    }

    private _startPing(): void {
        if (this._config.ping !== true || this._config.pingInterval <= 0 || !this.isConnected) {
            return;
        }
        this._pingInterval = setInterval(() => {
            if (!this.isConnected) {
                this._stopPing();
                return;
            }
            this.ping();
            this._pongTimeout = setTimeout(function () {
                this._disconnect('no ping', true);
            }, this._config.pongWaitTimeout);
        }, this._config.pingInterval);
    }

    private _restartPing(): void {
        this._stopPing();
        this._startPing();
    }

    private _resetRetry(): void {
        this._debug('Reset retries count to 0');
        this._retries = 0;
    }

    private _getRetryInterval(): number {
        this._retries += 1;
        const jitter = 0.5 * Math.random();
        let interval = this._config.retry * Math.pow(2, this._retries + 1);
        if (interval > this._config.maxRetry) {
            interval = this._config.maxRetry;
        }
        return Math.floor((1 - jitter) * interval);
    }

    private _refreshFailed(): void {
        this._numRefreshFailed = 0;
        if (!this.isDisconnected) {
            this._disconnect('refresh failed');
        }
        if (this._config.refreshFailed) {
            this._config.refreshFailed();
        }
    }

    private _refresh(): void {
        // ask web app for connection parameters - user ID, time, info and sign
        this._debug('Refresh credentials');

        if (this._config.refreshAttempts === 0) {
            this._debug('Refresh attempts set to 0, do not send refresh request at all');
            this._refreshFailed();
            return;
        }

        if (this._refreshTimeout !== null) {
            clearTimeout(this._refreshTimeout);
        }

        const cb = (err: boolean, data: ICentrifugeCredentials) => {
            if (err === true) {
                // We don't perform any connection status related actions here as we are
                // relying on Centrifugo that must close connection eventually.
                this._debug('Error getting connection credentials from refresh endpoint', data);
                this._numRefreshFailed++;
                if (this._refreshTimeout) {
                    clearTimeout(this._refreshTimeout);
                }
                if (this._config.refreshAttempts !== null && this._numRefreshFailed >= this._config.refreshAttempts) {
                    this._refreshFailed();
                    return;
                }
                this._refreshTimeout = setTimeout(() => {
                    this._refresh();
                }, this._config.refreshInterval + Math.round(Math.random() * 1000));
                return;
            }
            this._numRefreshFailed = 0;
            this._config.user = data.user;
            this._config.time = data.time;
            this._config.sign = data.sign;
            if ('info' in data) {
                this._config.info = data.info;
            } else {
                data.info = '';
            }
            if (this.isDisconnected) {
                this._debug('Credentials refreshed, connect from scratch');
                this.connect();
            } else {
                this._debug('Send refreshed credentials');
                this.addMessage(<ICentrifugeRefreshMessage>{
                    method: 'refresh',
                    params: data,
                }).then((response: ICentrifugeRefreshResponse) => {
                    this._refreshResponse(response);
                }, (error: ICentrifugeError) => {
                });
            }
        };

        if (this._config.onRefresh !== null) {
            this._config.onRefresh({}, cb);
        } else {
            this._request(
                this._config.refreshEndpoint,
                this._config.refreshParams,
                this._config.refreshHeaders,
                this._config.refreshData,
                cb
            );
        }
    }

    private _connectResponse(response: ICentrifugeConnectResponse): void {
        if (this.isConnected) {
            return;
        }
        if (this._latencyStart !== null) {
            this._latency = (new Date()).getTime() - this._latencyStart.getTime();
            this._latencyStart = null;
        }
        if (response.expires) {
            if (response.expired) {
                this._reconnecting = true;
                this._disconnect('expired', true);
                this._refresh();
                return;
            }
        }
        this._clientID = response.client;
        this._setStatus('connected');

        if (this._refreshTimeout) {
            clearTimeout(this._refreshTimeout);
        }

        if (response.expires) {
            this._refreshTimeout = setTimeout(() => {
                this._refresh();
            }, response.ttl * 1000);
        }

        if (this._config.resubscribe) {
            this.startBatching();
            this.startAuthBatching();
            for (const channel in this._subs) {
                if (this._subs.hasOwnProperty(channel)) {
                    const sub = this._getSub(channel);
                    if (sub.shouldResubscribe()) {
                        this.subscribeSub(sub);
                    }
                }
            }
            this.stopAuthBatching();
            this.stopBatching(true);
        }

        this._restartPing();
        this.trigger('connect', [{
            version: response.version,
            client: response.client,
            transport: this._transportName,
            latency: this._latency
        }]);
    }

    private _subscribeResponse(response: ICentrifugeSubscribeResponse): void {
        const channel = response.channel;
        const sub = this._getSub(channel);
        if (!sub || !sub.isSubscribing) {
            return;
        }
        let messages = response.messages;
        if (messages && messages.length > 0) {
            // handle missed messages
            messages = messages.reverse();
            for (const i in messages) {
                if (messages.hasOwnProperty(i)) {
                    this._messageResponse(<ICentrifugeMessage>{
                        body: messages[i]
                    });
                }
            }
        } else {
            if ('last' in response) {
                // no missed messages found so set last message id from body.
                this._lastMessageID[channel] = response.last;
            }
        }
        let recovered = false;
        if ('recovered' in response) {
            recovered = response.recovered;
        }
        sub.setSubscribeSuccess(recovered);
    }

    private _subscribeError(error: ICentrifugeError): void {
        const channel = error.channel;
        const sub = this._getSub(channel);
        if (!sub || !sub.isSubscribing) {
            return;
        }
        this.trigger('error', [{
            error,
        }]);
        sub.setSubscribeError(error);
    }

    private _unsubscribeResponse(response: ICentrifugeUnsubscribeResponse): void {
        const sub = this._getSub(response.channel);
        if (!sub) {
            return;
        }
        sub.setUnsubscribed();
    }

    private _joinResponse(response: ICentrifugeJoinResponse): void {
        const sub = this._getSub(response.channel);
        if (!sub) {
            return;
        }
        sub.trigger('join', [response]);
    }

    private _leaveResponse(response: ICentrifugeLeaveResponse): void {
        const sub = this._getSub(response.channel);
        if (!sub) {
            return;
        }
        sub.trigger('leave', [response]);
    }

    private _refreshResponse(response: ICentrifugeRefreshResponse): void {
        if (this._refreshTimeout) {
            clearTimeout(this._refreshTimeout);
        }
        if (response.expires) {
            if (response.expired) {
                this._refreshTimeout = setTimeout(() => {
                    this._refresh();
                }, this._config.refreshInterval + Math.round(Math.random() * 1000));
                return;
            }
            this._clientID = response.client;
            this._refreshTimeout = setTimeout(() => {
                this._refresh();
            }, response.ttl * 1000);
        }
    }

    private _messageResponse(message: ICentrifugeMessage): void {
        const body = message.body;
        const channel = body.channel;

        // keep last uid received from channel.
        this._lastMessageID[channel] = body.uid;

        const sub = this._getSub(channel);
        if (!sub) {
            return;
        }
        sub.trigger('message', [body]);
    }

    private _handleResponse(message: ICentrifugeMessage): void {
        const uid = message.uid;
        if (!(uid in this._callbacks)) {
            return;
        }
        const callbacks = this._callbacks[uid];
        delete this._callbacks[uid];
        if (!errorExists(message)) {
            const callback = callbacks.callback;
            if (isFunction(callback)) {
                callback(message.body);
            }
        } else {
            const errback = callbacks.errback;
            if (isFunction(errback)) {
                errback(Centrifuge.createErrorObject(message.error, message.advice));
            }
            this.trigger('error', [{
                message,
            }]);
        }
    }

    private _dispatchMessage(message: any): void {
        if (message === undefined || message === null) {
            this._debug('Dispatch: got undefined or null message');
            return;
        }
        switch (message.method) {
            case 'join':
                this._joinResponse(message);
                break;
            case 'leave':
                this._leaveResponse(message);
                break;
            case 'message':
                this._messageResponse(message);
                break;
            default:
                this._handleResponse(message);
        }
    }

    private _receive(data: any): void {
        if (Object.prototype.toString.call(data) === Object.prototype.toString.call([])) {
            // array of responses received
            for (const i in data) {
                if (data.hasOwnProperty(i)) {
                    this._dispatchMessage(data[i]);
                }
            }
        } else if (Object.prototype.toString.call(data) === Object.prototype.toString.call({})) {
            // one response received
            this._dispatchMessage(data);
        }
    }

    private _setTransport(): void {
        if (this._isSockJS) {
            const sockjsOptions: ISockJSOptions = {
                transports: this._config.transports
            };
            if (this._config.server) {
                sockjsOptions.server = this._config.server;
            }
            this._transport = new this._config.sockJS(this._getSockjsEndpoint(), null, sockjsOptions);
        } else {
            this._transport = new WebSocket(this._getWebsocketEndpoint());
        }

        this._transport.onopen = () => {
            this._transportClosed = false;
            this._reconnecting = false;

            if (this._isSockJS) {
                this._transportName = this._transport.transport;
                this._transport.onheartbeat = () => {
                    this._restartPing();
                };
            } else {
                this._transportName = 'raw-websocket';
            }

            this._resetRetry();

            const msg: ICentrifugeConnectMessage = {
                method: 'connect',
                params: {
                    user: this._config.user,
                    info: this._config.info,
                }
            };

            if (!this._config.insecure) {
                // in insecure client mode we don't need time and sign.
                msg.params.time = this._config.time;
                msg.params.sign = this._config.sign;
            }
            this._latencyStart = new Date();
            this.addMessage(msg).then((response: ICentrifugeConnectResponse) => {
                this._connectResponse(response);
            }, (error: ICentrifugeError) => {
            });
        };

        this._transport.onerror = (error: any) => {
            this._debug('Transport level error', error);
        };

        this._transport.onclose = (event: any) => {
            this._transportClosed = true;
            let reason = 'Connection closed';
            let reconnect = true;
            if (event && 'reason' in event && event.reason) {
                try {
                    const advice = JSON.parse(event.reason);
                    this._debug(reason + '. Reason is an advice object:', advice);
                    reason = advice.reason;
                    reconnect = advice.reconnect;
                } catch (e) {
                    reason = event.reason;
                    this._debug(reason + '. Reason is a plain string:', reason);
                    reconnect = reason !== 'disconnect';
                }
            }

            // onTransportClose callback should be executed every time transport was closed.
            // This can be helpful to catch failed connection events (because our disconnect
            // event only called once and every future attempts to connect do not fire disconnect
            // event again).
            if (this._config.onTransportClose) {
                this._config.onTransportClose({
                    event,
                    reason,
                    reconnect,
                });
            }

            this._disconnect(reason, reconnect);

            if (this._reconnect === true) {
                this._reconnecting = true;
                const interval = this._getRetryInterval();
                this._debug('Reconnect after ' + interval + ' milliseconds');
                setTimeout(() => {
                    if (this._reconnect === true) {
                        this.connect();
                    }
                }, interval);
            }
        };

        this._transport.onmessage = (event: any) => {
            const replies = event.data.split("\n");
            for (const i in replies) {
                if (!replies[i]) {
                    continue;
                }
                const data = JSON.parse(replies[i]);
                this._debug('Received', data);
                this._receive(data);
            }
            this._restartPing();
        };
    }

}

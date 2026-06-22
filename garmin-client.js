'use strict';

const axios = require('axios');
const crypto = require('crypto');
const logger = require('./logger');

// Garmin Connect's unofficial login flow (modelled on the well-known `garth`
// approach): SSO username/password login -> service ticket -> OAuth1 token ->
// OAuth2 bearer token, which is then used against connectapi.garmin.com.
//
// This is an UNOFFICIAL, undocumented flow. Garmin can change it at any time,
// and accounts protected by MFA will not log in with username/password alone.
const SSO = 'https://sso.garmin.com/sso';
const SSO_EMBED = `${SSO}/embed`;
const CONNECT_API = 'https://connectapi.garmin.com';
const USER_AGENT = 'com.garmin.android.apps.connectmobile';
const OAUTH_CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json';

// Public (non-secret) consumer credentials identifying the Garmin mobile app.
// Used as a fallback if the live lookup above is unreachable.
const FALLBACK_CONSUMER = {
  consumer_key: 'fc3e99d2-118c-44b8-8ae3-03370dde24c0',
  consumer_secret: 'E08WAR897WEy2knn7aFBrvegVAf0AFdWBBF',
};

function percentEncode(str) {
  return encodeURIComponent(String(str)).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function oauth1Header(method, url, consumer, token) {
  const oauthParams = {
    oauth_consumer_key: consumer.consumer_key,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
  };
  if (token && token.oauth_token) oauthParams.oauth_token = token.oauth_token;

  const u = new URL(url);
  const allParams = { ...oauthParams };
  for (const [k, v] of u.searchParams.entries()) allParams[k] = v;

  const baseUrl = `${u.origin}${u.pathname}`;
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join('&');
  const baseString = [method.toUpperCase(), percentEncode(baseUrl), percentEncode(paramString)].join('&');
  const signingKey = `${percentEncode(consumer.consumer_secret)}&${percentEncode(
    token && token.oauth_token_secret ? token.oauth_token_secret : ''
  )}`;
  oauthParams.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  return (
    'OAuth ' +
    Object.keys(oauthParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
      .join(', ')
  );
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }
  store(setCookie) {
    if (!setCookie) return;
    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const c of arr) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

class GarminClient {
  constructor(email, password) {
    this.email = email;
    this.password = password;
    this.jar = new CookieJar();
    this.oauth2 = null;
    this.tokenExpiry = 0;
    this._consumer = null;
  }

  _extract(html, re) {
    if (typeof html !== 'string') return null;
    const m = html.match(re);
    return m ? m[1] : null;
  }

  async _getConsumer() {
    if (this._consumer) return this._consumer;
    try {
      const { data } = await axios.get(OAUTH_CONSUMER_URL, { timeout: 10000 });
      if (data && data.consumer_key && data.consumer_secret) {
        this._consumer = data;
        return data;
      }
    } catch (e) {
      logger.warn('Could not fetch Garmin OAuth consumer, using fallback: %s', e.message);
    }
    this._consumer = FALLBACK_CONSUMER;
    return this._consumer;
  }

  async _get(url, params, headers = {}) {
    const res = await axios.get(url, {
      params,
      maxRedirects: 0,
      validateStatus: () => true,
      headers: { 'User-Agent': USER_AGENT, Cookie: this.jar.header(), ...headers },
    });
    this.jar.store(res.headers['set-cookie']);
    return res;
  }

  async _post(url, params, body, headers = {}) {
    const qs = new URLSearchParams(params).toString();
    const res = await axios.post(`${url}?${qs}`, body, {
      maxRedirects: 0,
      validateStatus: () => true,
      headers: { 'User-Agent': USER_AGENT, Cookie: this.jar.header(), ...headers },
    });
    this.jar.store(res.headers['set-cookie']);
    return res;
  }

  async login() {
    this.jar = new CookieJar();
    const consumer = await this._getConsumer();

    const ssoParams = {
      id: 'gauth-widget',
      embedWidget: 'true',
      gauthHost: SSO,
      service: SSO_EMBED,
      source: SSO_EMBED,
      redirectAfterAccountLoginUrl: SSO_EMBED,
      redirectAfterAccountCreationUrl: SSO_EMBED,
    };

    // 1. Seed cookies from the embed widget.
    await this._get(SSO_EMBED, { id: 'gauth-widget', embedWidget: 'true', gauthHost: SSO });

    // 2. GET the sign-in page to obtain the CSRF token.
    const signinGet = await this._get(`${SSO}/signin`, ssoParams, { Referer: SSO_EMBED });
    const csrf = this._extract(signinGet.data, /name="_csrf"\s+value="([^"]+)"/);
    if (!csrf) throw new Error('Could not obtain Garmin CSRF token (login page changed or request blocked)');

    // 3. POST credentials.
    const signinPost = await this._post(
      `${SSO}/signin`,
      ssoParams,
      new URLSearchParams({
        username: this.email,
        password: this.password,
        embed: 'true',
        _csrf: csrf,
      }).toString(),
      { Referer: `${SSO}/signin`, 'Content-Type': 'application/x-www-form-urlencoded' }
    );

    const ticket =
      this._extract(signinPost.data, /embed\?ticket=([^"]+)"/) ||
      this._extract(signinPost.data, /ticket=([A-Za-z0-9-]+)/);
    if (!ticket) {
      throw new Error('Garmin login failed: no service ticket returned (check credentials or MFA)');
    }

    // 4. Exchange ticket for an OAuth1 token.
    const oauth1 = await this._getOauth1(ticket, consumer);
    // 5. Exchange OAuth1 token for an OAuth2 bearer token.
    this.oauth2 = await this._exchange(oauth1, consumer);
    const ttl = (this.oauth2.expires_in || 3600) * 1000;
    this.tokenExpiry = Date.now() + ttl - 60000;
    logger.info('Garmin login successful');
    return true;
  }

  async _getOauth1(ticket, consumer) {
    const url =
      `${CONNECT_API}/oauth-service/oauth/preauthorized` +
      `?ticket=${encodeURIComponent(ticket)}` +
      `&login-url=${encodeURIComponent(SSO_EMBED)}` +
      `&accepts-mfa-tokens=true`;
    const auth = oauth1Header('GET', url, consumer, null);
    const { data, status } = await axios.get(url, {
      headers: { Authorization: auth, 'User-Agent': USER_AGENT },
      validateStatus: () => true,
    });
    if (status >= 400) throw new Error(`Garmin OAuth1 request failed (HTTP ${status})`);
    const params = new URLSearchParams(data);
    const token = {
      oauth_token: params.get('oauth_token'),
      oauth_token_secret: params.get('oauth_token_secret'),
    };
    if (!token.oauth_token) throw new Error('Garmin OAuth1 token missing from response');
    return token;
  }

  async _exchange(oauth1, consumer) {
    const url = `${CONNECT_API}/oauth-service/oauth/exchange/user/2.0`;
    const auth = oauth1Header('POST', url, consumer, oauth1);
    const { data, status } = await axios.post(url, '', {
      headers: {
        Authorization: auth,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      validateStatus: () => true,
    });
    if (status >= 400) throw new Error(`Garmin OAuth2 exchange failed (HTTP ${status})`);
    if (!data || !data.access_token) throw new Error('Garmin OAuth2 access_token missing from response');
    return data;
  }

  async ensureLogin() {
    if (this.oauth2 && Date.now() < this.tokenExpiry) return;
    await this.login();
  }

  _authHeaders() {
    return {
      Authorization: `Bearer ${this.oauth2.access_token}`,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    };
  }

  // Returns the most recent heart rate reading Garmin Connect has for today,
  // as { timestamp, bpm }, or null if none is available yet.
  //
  // NOTE: Garmin Connect does not expose a true real-time/live stream. It
  // surfaces the latest reading once the watch syncs (typically every few
  // minutes), so "live" here means "most recent value Garmin knows about".
  async getLatestHeartRate() {
    await this.ensureLogin();
    const date = new Date().toISOString().slice(0, 10);
    const url = `${CONNECT_API}/wellness-service/wellness/dailyHeartRate?date=${date}`;
    const res = await axios.get(url, { headers: this._authHeaders(), validateStatus: () => true });
    if (res.status === 401) {
      this.oauth2 = null;
      await this.ensureLogin();
      const retry = await axios.get(url, { headers: this._authHeaders(), validateStatus: () => true });
      if (retry.status >= 400) throw new Error(`Garmin HR request failed (HTTP ${retry.status})`);
      return this._latestFrom(retry.data);
    }
    if (res.status >= 400) throw new Error(`Garmin HR request failed (HTTP ${res.status})`);
    return this._latestFrom(res.data);
  }

  _latestFrom(data) {
    const values = data && data.heartRateValues;
    if (!Array.isArray(values) || !values.length) return null;
    for (let i = values.length - 1; i >= 0; i--) {
      const [ts, bpm] = values[i];
      if (typeof bpm === 'number') return { timestamp: ts, bpm };
    }
    return null;
  }
}

module.exports = GarminClient;

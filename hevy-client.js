'use strict';

const axios = require('axios');
const logger = require('./logger');

// Thin wrapper around the official Hevy API (https://api.hevyapp.com).
// Auth is via the `api-key` header.
class HevyClient {
  constructor(apiKey, base = 'https://api.hevyapp.com/v1') {
    this.http = axios.create({
      baseURL: base,
      timeout: 15000,
      headers: { 'api-key': apiKey, Accept: 'application/json' },
    });
  }

  async testConnection() {
    const { data } = await this.http.get('/workouts/count');
    return data;
  }

  async getRecentWorkouts(pageSize = 5) {
    const { data } = await this.http.get('/workouts', { params: { page: 1, pageSize } });
    if (data && Array.isArray(data.workouts)) return data.workouts;
    if (Array.isArray(data)) return data;
    return [];
  }

  async getWorkout(id) {
    const { data } = await this.http.get(`/workouts/${id}`);
    return data;
  }
}

module.exports = HevyClient;

'use strict';
// Private JSON persistence. Use one server process per data file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
class JsonStore {
  constructor(filename) {
    this.filename = filename;
    this.data = filename !== ':memory:' && fs.existsSync(filename)
      ? JSON.parse(fs.readFileSync(filename, 'utf8'))
      : { version: 1, users: [], sessions: [], learning_events: [] };
    if (this.data.version !== 1 || !['users', 'sessions', 'learning_events'].every(key => Array.isArray(this.data[key]))) {
      throw Error('Invalid account JSON file. Restore a valid backup; existing data was not overwritten.');
    }
    if (filename !== ':memory:' && !fs.existsSync(filename)) this.commit(this.data);
  }
  // Save completely before replacing the previous file; failed writes keep prior data.
  commit(next) {
    if (this.filename !== ':memory:') {
      fs.mkdirSync(path.dirname(this.filename), { recursive: true });
      const temporary = this.filename + '.' + crypto.randomUUID() + '.tmp';
      let descriptor;
      try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, JSON.stringify(next, null, 2) + '\n');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor); descriptor = undefined;
        fs.renameSync(temporary, this.filename);
      } catch (error) {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        throw error;
      }
    }
    this.data = next;
  }
  // Synchronous copy-on-write mutations avoid interleaved requests losing updates.
  update(change) {
    const next = structuredClone(this.data);
    change(next);
    this.commit(next);
  }
  userById(id) { return this.data.users.find(user => user.id === id); }
  userByEmail(email) { return this.data.users.find(user => user.email === email); }
  addUser(user) {
    if (this.userByEmail(user.email)) throw Error('Duplicate email');
    this.update(data => data.users.push(user));
  }
  session(tokenHash, now) {
    const session = this.data.sessions.find(item => item.token_hash === tokenHash && item.expires_at > now);
    const user = session && this.userById(session.user_id);
    return user ? { ...user, ...session } : null;
  }
  replaceSession(oldHash, session, now) {
    this.update(data => {
      data.sessions = data.sessions.filter(item => item.token_hash !== oldHash && item.expires_at > now);
      data.sessions.push(session);
    });
  }
  removeSession(tokenHash) {
    this.update(data => { data.sessions = data.sessions.filter(item => item.token_hash !== tokenHash); });
  }
  addEvent(event) {
    if (this.data.learning_events.some(item => item.user_id === event.user_id && item.event_id === event.event_id)) return;
    this.update(data => data.learning_events.push(event));
  }
  progressRows(userId) {
    const groups = new Map();
    for (const event of this.data.learning_events.filter(item => item.user_id === userId)) {
      const key = event.stage + ':' + event.sound_key;
      const row = groups.get(key) || { stage: event.stage, sound_key: event.sound_key, plays: 0, last_completed: 0 };
      row.plays++;
      row.last_completed = Math.max(row.last_completed, event.completed_at);
      groups.set(key, row);
    }
    return [...groups.values()];
  }
}
module.exports = { JsonStore };

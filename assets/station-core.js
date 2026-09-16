(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Station = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  function safeURL(value) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return '';
    try {
      const url = new URL(value.trim());
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }
  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  }
  function beijingDate(value = Date.now()) {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 10) : '';
  }
  function formatDate(value) {
    if (!validDate(value)) return '';
    return new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'}).format(new Date(value + 'T12:00:00+08:00'));
  }
  function normalizeItem(item) {
    if (!item || typeof item.title !== 'string') return null;
    const link = safeURL(item.link || item.sourceUrl);
    if (!link || !item.title.trim()) return null;
    const color = /^#[\da-f]{3,8}$/i.test(item.color || item._feed?.color || '') ? (item.color || item._feed.color) : '#6b7280';
    return {...item, title: item.title.trim(), link, _fromStatic: true,
      source: String(item.source || item.sourceName || item._feed?.name || '来源未标注'),
      _feed: {name: String(item.source || item.sourceName || item._feed?.name || '来源未标注'), color}};
  }
  function validSnapshot(data, expectedDate) {
    return !!data && validDate(data.date) && (!expectedDate || data.date === expectedDate)
      && Array.isArray(data.sections) && data.sections.length > 0
      && data.sections.every(section => section && typeof section.label === 'string' && Array.isArray(section.items)
        && section.items.every(item => item && typeof item.title === 'string' && item.title.trim()
          && typeof item.summary === 'string' && safeURL(item.sourceUrl)))
      && data.sections.some(section => section.items.length > 0);
  }
  function snapshotSources(data) {
    return [...new Set((data?.sections || []).flatMap(section => section.items || []).map(item => item.sourceName || '来源未标注'))]
      .map(name => ({name, color: '#6b7280'}));
  }
  function shareSections(data) {
    if (!validSnapshot(data)) throw new Error('Invalid daily snapshot');
    return data.sections.filter(section => section.items.length).map(section => ({
      title: section.label, items: section.items.slice(0, 3)
    }));
  }
  function formatUpdated(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return '更新时间未记录';
    return new Intl.DateTimeFormat('zh-CN', {timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false}).format(new Date(value));
  }
  function createDataClient(options = {}) {
    const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
    let storage = options.storage;
    if (storage === undefined) { try { storage = globalThis.localStorage; } catch {} }
    const memory = new Map(), inflight = new Map();
    const prefix = 'ai_station_data_v3:';
    function peek(url, validate = () => true) {
      let entry = memory.get(url);
      if (!entry) {
        try { entry = JSON.parse(storage?.getItem(prefix + url) || 'null'); } catch {}
      }
      if (!entry || !validate(entry.data)) return null;
      memory.set(url, entry);
      return entry;
    }
    async function get(url, {force = false, validate = () => true, ttl = 300000} = {}) {
      const previous = peek(url, validate);
      if (!force && previous && Date.now() - previous.checkedAt < ttl) return {...previous, stale: false};
      if (inflight.has(url)) return inflight.get(url);
      const work = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeout || 12000);
        try {
          const response = await fetcher(url, {signal: controller.signal, cache: 'no-cache'});
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          if (!validate(data)) throw new Error('Invalid data');
          const entry = {data, checkedAt: Date.now()};
          memory.set(url, entry);
          try { storage?.setItem(prefix + url, JSON.stringify(entry)); } catch {}
          return {...entry, stale: false};
        } catch (error) {
          if (previous) return {...previous, stale: true};
          throw error;
        } finally { clearTimeout(timer); }
      })();
      inflight.set(url, work);
      try { return await work; } finally { inflight.delete(url); }
    }
    return {get, peek};
  }
  return {escapeHTML, safeURL, validDate, beijingDate, formatDate, formatUpdated, normalizeItem, validSnapshot, snapshotSources, shareSections, createDataClient};
});

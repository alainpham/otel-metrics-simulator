// Builds OTLP/HTTP JSON payloads by hand and POSTs them to the configured
// endpoint with plain REST calls (no OpenTelemetry SDK involved).
// Spec: https://opentelemetry.io/docs/specs/otlp/#otlphttp

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const logger = require("./logger");

const METRIC_TYPES = ["gauge", "counter", "updowncounter", "histogram"];
const AGGREGATION_TEMPORALITY_CUMULATIVE = 2;
const MAX_LOG_ENTRIES = 100;
const CONFIG_FILE = process.env.SIM_CONFIG_FILE || path.join(__dirname, "../data/config.json");

// used when CONFIG_FILE does not exist yet
const DEFAULT_CONFIG = {
    endpoint: process.env.SIM_OTLP_ENDPOINT || "http://localhost:4318",
    headers: [],
    basicAuth: { username: "", password: "" },
    metrics: [
        exampleMetric("m1", "webshop", "frontend", 1),
        exampleMetric("m2", "webshop", "cart", 1),
        exampleMetric("m3", "webshop", "checkout", 1),
        exampleMetric("m4", "payments", "payment-gateway", 1),
        exampleMetric("m5", "payments", "fraud-detection", 0)
    ]
};

// Initial example: a Prometheus style "up" gauge per service, 1 when the
// service is up and 0 when it is down.
function exampleMetric(id, application, serviceName, value) {
    return {
        id,
        enabled: true,
        name: "up",
        description: "Whether the service is up (1) or down (0)",
        unit: "",
        type: "gauge",
        intervalSeconds: 15,
        valueMode: "constant",
        value,
        min: 0,
        max: 1,
        buckets: "",
        resourceAttributes: [
            { key: "service.name", value: serviceName },
            { key: "service.instance.id", value: "otelsimulator" }
        ],
        attributes: [{ key: "application", value: application }]
    };
}

function saveConfigFile(cfg) {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    // write then rename so a crash never leaves a half written file
    const tmp = CONFIG_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
    fs.renameSync(tmp, CONFIG_FILE);
}

// Older files had a single global resourceAttributes list: move it onto
// each metric so they keep sending the same resource.
function normalize(cfg) {
    if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.metrics)) return cfg;
    const shared = Array.isArray(cfg.resourceAttributes) ? cfg.resourceAttributes : [];
    const { resourceAttributes, ...rest } = cfg;
    return {
        ...rest,
        metrics: cfg.metrics.map((m) => ({
            ...m,
            resourceAttributes: Array.isArray(m.resourceAttributes) ? m.resourceAttributes : structuredClone(shared)
        }))
    };
}

function loadConfigFile() {
    if (!fs.existsSync(CONFIG_FILE)) {
        try {
            saveConfigFile(DEFAULT_CONFIG);
            logger.info({ file: CONFIG_FILE }, "Created configuration file with defaults");
        } catch (err) {
            logger.error({ file: CONFIG_FILE, err: err.message }, "Failed to create configuration file");
        }
        return DEFAULT_CONFIG;
    }
    try {
        const cfg = normalize(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")));
        const errors = validate(cfg);
        if (errors.length) throw new Error(errors.join("; "));
        logger.info({ file: CONFIG_FILE, metrics: cfg.metrics.length }, "Loaded configuration file");
        return cfg;
    } catch (err) {
        // keep the broken file untouched so it can be fixed by hand
        logger.error({ file: CONFIG_FILE, err: err.message }, "Invalid configuration file, using defaults");
        return DEFAULT_CONFIG;
    }
}

let config = loadConfigFile();
let running = false;
const timers = new Map(); // metric id -> interval handle
const state = new Map();  // metric id -> runtime state (cumulative values, stats)
const activity = [];

function nowNanos() {
    return (BigInt(Date.now()) * 1000000n).toString();
}

function toKeyValues(list) {
    return (list || [])
        .filter((a) => a.key)
        .map((a) => ({ key: a.key, value: { stringValue: String(a.value ?? "") } }));
}

function parseBuckets(buckets) {
    return String(buckets || "")
        .split(",")
        .filter((b) => b.trim() !== "")
        .map((b) => Number(b.trim()))
        .filter((b) => !Number.isNaN(b))
        .sort((a, b) => a - b);
}

function nextValue(metric) {
    if (metric.valueMode === "random") {
        const min = Number(metric.min);
        const max = Number(metric.max);
        return Math.round((min + Math.random() * (max - min)) * 1000) / 1000;
    }
    return Number(metric.value);
}

function stateFor(metric) {
    if (!state.has(metric.id)) {
        state.set(metric.id, {
            startTimeUnixNano: nowNanos(),
            cumulative: 0,
            histogram: null,
            sent: 0,
            errors: 0,
            lastValue: null,
            lastSentAt: null,
            lastStatus: null,
            lastError: null
        });
    }
    return state.get(metric.id);
}

// Advances the metric's runtime state by one tick and returns the OTLP
// metric object together with the value that was recorded.
function buildMetric(metric, st) {
    const value = nextValue(metric);
    const base = {
        name: metric.name,
        description: metric.description || "",
        unit: metric.unit || ""
    };
    const point = {
        attributes: toKeyValues(metric.attributes),
        timeUnixNano: nowNanos()
    };

    switch (metric.type) {
        case "counter":
            // counters only go up: value is the increment added on each tick
            st.cumulative += Math.abs(value);
            return {
                value,
                otlp: {
                    ...base,
                    sum: {
                        aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
                        isMonotonic: true,
                        dataPoints: [{ ...point, startTimeUnixNano: st.startTimeUnixNano, asDouble: st.cumulative }]
                    }
                }
            };
        case "updowncounter":
            st.cumulative += value;
            return {
                value,
                otlp: {
                    ...base,
                    sum: {
                        aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
                        isMonotonic: false,
                        dataPoints: [{ ...point, startTimeUnixNano: st.startTimeUnixNano, asDouble: st.cumulative }]
                    }
                }
            };
        case "histogram": {
            // each tick records one observation into cumulative buckets
            const bounds = parseBuckets(metric.buckets);
            if (!st.histogram || st.histogram.bounds.join() !== bounds.join()) {
                st.histogram = { bounds, counts: new Array(bounds.length + 1).fill(0), count: 0, sum: 0, min: value, max: value };
            }
            const h = st.histogram;
            const idx = bounds.findIndex((b) => value <= b);
            h.counts[idx === -1 ? bounds.length : idx] += 1;
            h.count += 1;
            h.sum += value;
            h.min = Math.min(h.min, value);
            h.max = Math.max(h.max, value);
            return {
                value,
                otlp: {
                    ...base,
                    histogram: {
                        aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE,
                        dataPoints: [{
                            ...point,
                            startTimeUnixNano: st.startTimeUnixNano,
                            count: String(h.count),
                            sum: h.sum,
                            min: h.min,
                            max: h.max,
                            bucketCounts: h.counts.map(String),
                            explicitBounds: h.bounds
                        }]
                    }
                }
            };
        }
        default:
            return { value, otlp: { ...base, gauge: { dataPoints: [{ ...point, asDouble: value }] } } };
    }
}

// entries: [{ metric, otlp }], each metric carries its own resource
function buildPayload(entries) {
    return {
        resourceMetrics: entries.map(({ metric, otlp }) => ({
            resource: { attributes: toKeyValues(metric.resourceAttributes) },
            scopeMetrics: [{
                scope: { name: "otel-metrics-simulator", version: "1.0.0" },
                metrics: [otlp]
            }]
        }))
    };
}

function metricsUrl() {
    const endpoint = config.endpoint.replace(/\/+$/, "");
    return endpoint.endsWith("/v1/metrics") ? endpoint : endpoint + "/v1/metrics";
}

function requestHeaders() {
    const headers = { "Content-Type": "application/json" };
    for (const h of config.headers || []) {
        if (h.key) headers[h.key] = h.value ?? "";
    }
    const { username, password } = config.basicAuth || {};
    if (username || password) {
        headers.Authorization = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    }
    return headers;
}

function addActivity(entry) {
    activity.unshift({ time: new Date().toISOString(), ...entry });
    activity.length = Math.min(activity.length, MAX_LOG_ENTRIES);
}

async function send(metric) {
    const st = stateFor(metric);
    const { value, otlp } = buildMetric(metric, st);
    const url = metricsUrl();
    st.lastValue = value;
    st.lastSentAt = new Date().toISOString();
    try {
        const res = await axios.post(url, buildPayload([{ metric, otlp }]), {
            headers: requestHeaders(),
            timeout: 10000,
            validateStatus: () => true
        });
        st.lastStatus = res.status;
        if (res.status >= 200 && res.status < 300) {
            st.sent += 1;
            st.lastError = null;
            addActivity({ metric: metric.name, value, status: res.status, ok: true });
        } else {
            const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
            throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
        }
    } catch (err) {
        st.errors += 1;
        st.lastError = err.message;
        addActivity({ metric: metric.name, value, status: st.lastStatus, ok: false, error: err.message });
        logger.warn({ metric: metric.name, url, err: err.message }, "Failed to send metric");
    }
}

function validate(newConfig) {
    const errors = [];
    if (!newConfig || typeof newConfig !== "object") return ["config must be an object"];
    try {
        new URL(newConfig.endpoint);
    } catch {
        errors.push("endpoint must be a valid URL");
    }
    if (!Array.isArray(newConfig.metrics)) errors.push("metrics must be an array");
    for (const [i, m] of (newConfig.metrics || []).entries()) {
        const label = `metric #${i + 1}`;
        if (!m.id) errors.push(`${label}: id is required`);
        if (!m.name) errors.push(`${label}: name is required`);
        if (!METRIC_TYPES.includes(m.type)) errors.push(`${label}: type must be one of ${METRIC_TYPES.join(", ")}`);
        if (!(Number(m.intervalSeconds) >= 1)) errors.push(`${label}: interval must be at least 1 second`);
        if (m.valueMode === "random") {
            if (Number.isNaN(Number(m.min)) || Number.isNaN(Number(m.max))) errors.push(`${label}: min and max must be numbers`);
            else if (Number(m.min) > Number(m.max)) errors.push(`${label}: min must be <= max`);
        } else if (m.value === "" || Number.isNaN(Number(m.value))) {
            errors.push(`${label}: value must be a number`);
        }
    }
    return errors;
}

function scheduleAll() {
    for (const handle of timers.values()) clearInterval(handle);
    timers.clear();
    if (!running) return;
    for (const metric of config.metrics) {
        if (!metric.enabled) continue;
        send(metric);
        timers.set(metric.id, setInterval(() => send(metric), Number(metric.intervalSeconds) * 1000));
    }
}

function setConfig(newConfig) {
    newConfig = normalize(newConfig);
    const errors = validate(newConfig);
    if (errors.length) return errors;

    // a metric whose identity changed starts a fresh cumulative series
    const previous = new Map(config.metrics.map((m) => [m.id, m]));
    for (const m of newConfig.metrics) {
        const old = previous.get(m.id);
        if (!old || old.name !== m.name || old.type !== m.type || JSON.stringify(old.attributes) !== JSON.stringify(m.attributes)
            || JSON.stringify(old.resourceAttributes) !== JSON.stringify(m.resourceAttributes)) {
            state.delete(m.id);
        }
    }
    const ids = new Set(newConfig.metrics.map((m) => m.id));
    for (const id of state.keys()) {
        if (!ids.has(id)) state.delete(id);
    }

    try {
        saveConfigFile(newConfig);
    } catch (err) {
        logger.error({ file: CONFIG_FILE, err: err.message }, "Failed to write configuration file");
        return [`could not write ${CONFIG_FILE}: ${err.message}`];
    }

    config = newConfig;
    scheduleAll();
    logger.info({ metrics: config.metrics.length, running }, "Configuration updated");
    return [];
}

function start() {
    running = true;
    scheduleAll();
    logger.info({ url: metricsUrl() }, "Simulation started");
}

function stop() {
    running = false;
    scheduleAll();
    logger.info("Simulation stopped");
}

function reset() {
    state.clear();
    activity.length = 0;
}

async function sendOnce() {
    await Promise.all(config.metrics.filter((m) => m.enabled).map(send));
}

// Payload as it would be sent on the next tick, without advancing any state.
function preview() {
    const entries = config.metrics
        .filter((m) => m.enabled)
        .map((m) => {
            const st = structuredClone(stateFor(m));
            return { metric: m, otlp: buildMetric(m, st).otlp };
        });
    return { url: metricsUrl(), payload: buildPayload(entries) };
}

function status() {
    return {
        running,
        url: metricsUrl(),
        metrics: config.metrics.map((m) => {
            const st = state.get(m.id);
            return {
                id: m.id,
                name: m.name,
                scheduled: timers.has(m.id),
                sent: st?.sent ?? 0,
                errors: st?.errors ?? 0,
                lastValue: st?.lastValue ?? null,
                cumulative: st && ["counter", "updowncounter"].includes(m.type) ? st.cumulative : null,
                lastSentAt: st?.lastSentAt ?? null,
                lastStatus: st?.lastStatus ?? null,
                lastError: st?.lastError ?? null
            };
        }),
        activity
    };
}

function getConfig() {
    return config;
}

module.exports = { getConfig, setConfig, start, stop, reset, sendOnce, preview, status, METRIC_TYPES };

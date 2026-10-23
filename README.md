# otel-metrics-simulator

This README provides instructions to build and run the otel-metrics-simulator using Docker.

## Using the simulator

Open http://localhost:8080 and:

1. **Connection**: enter the OTLP/HTTP endpoint (e.g. `http://localhost:4318` or
   `https://otlp-gateway-prod-eu-west-2.grafana.net/otlp`; `/v1/metrics` is appended)
   and optionally basic auth credentials (for Grafana Cloud: instance id + access policy token)
   and extra headers.
2. **Metrics**: add metrics with name, type (gauge, counter, up-down counter, histogram), unit,
   frequency in seconds, value (constant or random in a min/max range), resource attributes
   (e.g. `service.name`, sent in the OTLP `resource`) and data point attributes.
3. Click **Start**. Each metric is sent on its own interval as an OTLP JSON payload via a
   plain HTTP POST (no OpenTelemetry SDK). **Send once** sends a single round, **Preview payload**
   shows the JSON that will be sent.

Counters and histograms are cumulative: on each tick the value is added to the running total
(or recorded as one histogram observation).

The configuration is stored in `data/config.json` (override with `SIM_CONFIG_FILE`). It is created
with the example metrics on first start, rewritten on every **Save**, and loaded again at startup.
It can also be edited by hand while the server is stopped. If the file is invalid, the server logs
the error and starts with the defaults without touching the file. It contains the basic auth
credentials in clear text. `SIM_OTLP_ENDPOINT` sets the endpoint used in the defaults.
**Export JSON** / **Import JSON** in the UI download / upload the same format.

| API | Description |
| --- | --- |
| `GET/PUT /api/config` | read / replace the configuration |
| `POST /api/start`, `/api/stop` | start / stop sending |
| `POST /api/send-once` | send every enabled metric once |
| `POST /api/reset` | reset cumulative values and activity log |
| `GET /api/preview` | payload that would be sent next |
| `GET /api/status` | per-metric stats and recent activity |

## env vars for otel

```bash 
# exporter options are otlp, console, none
export OTEL_METRICS_EXPORTER="otlp"
export OTEL_LOGS_EXPORTER="otlp"
export OTEL_TRACES_EXPORTER="otlp"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4318"
export OTEL_SERVICE_NAME="otel-metrics-simulator"
export NODE_OPTIONS="--require @opentelemetry/auto-instrumentations-node/register"
```

## Prerequisites

- Docker installed on your machine
- Docker Compose installed on your machine

## Running locally for dev

```sh
npm install 
npm start
```

To auto-restart the server whenever a file under `server/` or `public/` changes,
and auto-reload the browser tab with it:

```sh
npm run dev
```

The browser reload uses a `/__livereload` SSE endpoint plus a small script
injected into served HTML. Both are gated behind `LIVERELOAD=1`, which only
`npm run dev` sets — `npm start` and the container image are untouched.


## Building the Docker Image

To build the Docker image for the otel-metrics-simulator, run the following command:

```sh
docker rmi alainpham/otel-metrics-simulator
docker build -t alainpham/otel-metrics-simulator .
```

## Pushing to repository

```sh
docker push alainpham/otel-metrics-simulator
```

## Running the Docker Container

To run the Docker container, use the following command:

```sh
docker run --rm -p 8080:8080 --name otel-metrics-simulator alainpham/otel-metrics-simulator
```

## Stopping the Docker Container

To stop the running container, use the following command:

```sh
docker stop otel-metrics-simulator
```

## Removing the Docker Container

To remove the stopped container, use the following command:

```sh
docker rm otel-metrics-simulator
```

## Deploy on kube

```sh
kubectl create ns apps
kubectl -n apps apply -f deploy.yaml
```
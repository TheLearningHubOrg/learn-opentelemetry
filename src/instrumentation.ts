// Loaded with `node --import` so it runs before any application module.
// 1. Register the ESM loader hook so modules imported later can be patched.
// 2. Start the SDK, which installs the global tracer, meter and logger providers.
import { register } from 'node:module';
import { startTelemetry } from './telemetry.js';

register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
startTelemetry();

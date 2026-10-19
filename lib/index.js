// Compatibility re-export. The real plugin entry point is ./entry.js (package.json
// "main" and the cordis patch both resolve there); this file stays so anything that
// imports the package root by habit keeps working. Do not edit both — edit entry.js.
export {
  name,
  inject,
  normalizeConfig,
  apply,
} from './entry.js';

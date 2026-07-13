// Registers the "@/*" alias resolver hook for the test runner.
import { register } from "node:module";
register("./alias-loader.mjs", import.meta.url);

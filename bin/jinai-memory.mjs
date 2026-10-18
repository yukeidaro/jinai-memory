#!/usr/bin/env node
import { main } from "../src/installer.js";

process.exitCode = await main();

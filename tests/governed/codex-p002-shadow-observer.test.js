"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { observeAccepted } = require("../../lib/governed/codex-p002-shadow-observer.js");

test("observer ignores missing admission",()=>assert.deepEqual(observeAccepted(),{status:"not_requested"}));
test("observer rejects private admission fields",()=>{const r=observeAccepted(JSON.stringify({attempt_id:"ocx-x",task_terms:["safe"],prompt:"secret"}));assert.deepEqual(r,{status:"rejected",error:"forbidden_field"});});
test("observer never exposes parse details",()=>{const r=observeAccepted("{privateSecret");assert.deepEqual(r,{status:"failed",ok:false,error:"pilot_failed"});});

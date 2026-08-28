"use strict";

// Dual renderer: page HTML + board HTML.

const board = require("./board");
const page = require("./page");

function renderDualPageHtml(brief, scene, pageNode, opts) {
  return page.renderPageHtml(brief, scene, pageNode, opts);
}

function renderDualBoardHtml(brief, scene, opts) {
  return board.renderBoardHtml(brief, scene, opts);
}

module.exports = { renderDualPageHtml, renderDualBoardHtml };
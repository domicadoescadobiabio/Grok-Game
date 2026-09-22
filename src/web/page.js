// Serving the screen.
//
// The markup, styles and client script live in ./public as real .html, .css and
// .js files rather than one template literal: they are editable, lintable, and
// the browser can cache them. This module only wires them to routes.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.resolve(here, '..', '..', 'public');

export const staticScreen = () => express.static(PUBLIC_DIR, {
  maxAge: '5m',          // short: the screen changes as often as the game does
  index: false,          // '/' is the plain-text connect note, not the app
});

export const screenPage = (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html'));

'use strict';
const { createHash } = require('node:crypto');
const path = require('node:path');

// Runtime.evaluate runs outside the application's CommonJS module scope.
const mainRequire = 'globalThis.process.mainModule.require';
const electron = `${mainRequire}('electron')`;
const electronReady = `Boolean(globalThis.process?.mainModule && ${electron}.app?.isReady())`;
const appBuild = `${mainRequire}(${electron}.app.getAppPath() + '/package.json').councilBuild`;

// Match src/main/floors.ts for the smoke's separately launched peer.
function floorPeerProfile(shared, home) {
  const id = createHash('sha1').update(path.resolve(home)).digest('hex').slice(0, 12);
  return path.join(shared, 'floors', id);
}

function hasAllFloorsView() {
  const nav = [...document.querySelectorAll('nav[aria-label="Floor views"]')]
    .find(element => !element.closest('[hidden]') && element.getClientRects().length);
  return nav?.closest('main')?.querySelector('h1')?.textContent.trim() === 'All floors';
}

function targetInRenderer({ query, operation }) {
  const scope = query.scope ? document.querySelector(query.scope) : document;
  const target = scope && [...scope.querySelectorAll(query.selector)].find(element =>
    (!query.text || (element.getAttribute('aria-label') || element.textContent).trim() === query.text)
    && !element.closest('[hidden]') && element.getClientRects().length);
  if (!target) return false;
  if (operation === 'focused') return target === document.activeElement;
  if (operation === 'focus' || operation === 'select') {
    target.focus();
    if (operation === 'select') target.select();
    return target === document.activeElement;
  }
  if (operation === 'center') {
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const { left, top, width, height } = target.getBoundingClientRect();
    return { x: left + width / 2, y: top + height / 2 };
  }
  return true;
}

function keyEvents(shortcut) {
  const shift = shortcut.startsWith('Shift+');
  const key = shift ? shortcut.slice(6) : shortcut;
  const code = { F10: 121, Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40 }[key];
  if (!code) throw new Error('Unsupported smoke key ' + shortcut);
  const common = { key, code: key, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0 };
  const text = key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {};
  return [{ ...common, ...text, type: key === 'Enter' ? 'keyDown' : 'rawKeyDown' }, { ...common, type: 'keyUp' }];
}

module.exports = { electron, electronReady, appBuild, floorPeerProfile, hasAllFloorsView, targetInRenderer, keyEvents };

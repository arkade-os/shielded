import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {test} from 'node:test';
import {NativeUpdateCopyLink} from '../app/src/AppUpdates.tsx';
import {NATIVE_RELEASE_ORIGIN} from '../src/native-release.ts';

test('native error fallback exposes a selectable download URL without depending on external navigation',()=>{
 const html=renderToStaticMarkup(createElement(NativeUpdateCopyLink));
 assert.match(html,/Update available/);assert.match(html,/open it outside Shielded/);
 assert.match(html,/aria-label="Download link to copy"/);assert.match(html,/readOnly=""/);
 assert.ok(html.includes(`value="${NATIVE_RELEASE_ORIGIN}/#download"`));assert.doesNotMatch(html,/<a\b/);
});

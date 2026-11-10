import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {test} from 'node:test';
import {NativeUpdateFallback,NativeUpdateLink} from '../app/src/AppUpdates.tsx';
import {nativeUpdateUrl} from '../src/native-release.ts';

test('native update availability is a direct external link',()=>{
 const html=renderToStaticMarkup(createElement(NativeUpdateLink));
 assert.match(html,/Update available/);assert.match(html,/<a\b/);
 assert.ok(html.includes(`href="${nativeUpdateUrl()}"`));assert.match(html,/data-native-external="true"/);
 assert.match(html,/aria-label="Native app update available. Open downloads."/);assert.doesNotMatch(html,/<input\b/);
});

test('a failed native opener offers the same download URL for copying',()=>{
 const html=renderToStaticMarkup(createElement(NativeUpdateFallback));
 assert.match(html,/Copy download link/);assert.match(html,/aria-label="Download link to copy"/);
 assert.ok(html.includes(`value="${nativeUpdateUrl()}"`));assert.match(html,/readOnly=""/);
});

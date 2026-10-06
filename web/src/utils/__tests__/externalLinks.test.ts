import { describe, it, expect } from 'vitest';
import { isExternalHref, externalAnchorHref } from '../externalLinks';

const MAC = 'tauri://localhost/index.html';
const WIN = 'http://tauri.localhost/';
const DEV = 'http://localhost:5173/';

describe('isExternalHref', () => {
  it('treats other sites as external', () => {
    for (const base of [MAC, WIN, DEV]) {
      expect(isExternalHref('https://github.com/a/b', base)).toBe(true);
      expect(isExternalHref('http://example.com', base)).toBe(true);
      expect(isExternalHref('http://192.168.1.5:9877/web', base)).toBe(true);
      expect(isExternalHref('mailto:a@b.c', base)).toBe(true);
      expect(isExternalHref('tel:+15550100', base)).toBe(true);
    }
  });

  it('a localhost link in a message is not the app', () => {
    expect(isExternalHref('http://localhost:3000', MAC)).toBe(true);
    expect(isExternalHref('http://localhost:3000', WIN)).toBe(true);
    // Another port than the dev server.
    expect(isExternalHref('http://localhost:3000', DEV)).toBe(true);
    expect(isExternalHref('https://tauri.localhost.evil.com/', WIN)).toBe(true);
  });

  it('keeps the app\'s own pages inside', () => {
    expect(isExternalHref('/settings', MAC)).toBe(false);
    expect(isExternalHref('#top', WIN)).toBe(false);
    expect(isExternalHref('index.html?x=1', DEV)).toBe(false);
    expect(isExternalHref('http://tauri.localhost/index.html', WIN)).toBe(false);
    expect(isExternalHref('http://localhost:5173/a', DEV)).toBe(false);
  });

  it('ignores empty and non-web hrefs', () => {
    expect(isExternalHref('', MAC)).toBe(false);
    expect(isExternalHref(null, MAC)).toBe(false);
    expect(isExternalHref(undefined, MAC)).toBe(false);
    expect(isExternalHref('javascript:void(0)', MAC)).toBe(false);
    expect(isExternalHref('blob:tauri://localhost/1', MAC)).toBe(false);
    expect(isExternalHref('data:text/plain,hi', MAC)).toBe(false);
    expect(isExternalHref('http://[', MAC)).toBe(false);
  });
});

describe('externalAnchorHref', () => {
  function anchor(html: string): Element {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div;
  }

  it('finds the link around the clicked element', () => {
    const root = anchor('<a href="https://example.com/x" target="_blank"><span id="t">x</span></a>');
    expect(externalAnchorHref(root.querySelector('#t'), WIN)).toBe('https://example.com/x');
  });

  it('leaves internal links, downloads and non-links alone', () => {
    const root = anchor(
      '<a href="/web/x"><i id="a">a</i></a>' +
      '<a href="https://example.com/f.zip" download><i id="b">b</i></a>' +
      '<p id="c">c</p>',
    );
    expect(externalAnchorHref(root.querySelector('#a'), WIN)).toBeNull();
    expect(externalAnchorHref(root.querySelector('#b'), WIN)).toBeNull();
    expect(externalAnchorHref(root.querySelector('#c'), WIN)).toBeNull();
    expect(externalAnchorHref(null, WIN)).toBeNull();
  });
});

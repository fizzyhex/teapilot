import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

export const editorTheme = (dark: boolean) => [
  EditorView.theme({
    '&': { height: 'var(--editor-height)', backgroundColor: 'var(--back)', color: 'var(--ink)', fontSize: '14px' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, "Liberation Mono", monospace', lineHeight: '1.6', scrollbarColor: 'var(--accent) var(--paper)' },
    '.cm-content': { padding: '12px 0', caretColor: 'var(--ink)' },
    '.cm-line': { padding: '0 14px' },
    '.cm-gutters': { backgroundColor: 'var(--back)', color: 'var(--muted)', border: 'none', paddingLeft: '8px' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--active-line)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--selection)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-panels, .cm-tooltip': { backgroundColor: 'var(--paper)', color: 'var(--ink)', borderColor: 'var(--muted)' },
  }, { dark }),
  syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.heading, tags.link], color: dark ? '#9bd3ef' : '#165d80', textDecoration: 'underline' },
    { tag: [tags.keyword, tags.modifier], color: dark ? '#d5b3ef' : '#713e91' },
    { tag: [tags.string, tags.inserted], color: dark ? '#a4ce95' : '#39682c' },
    { tag: [tags.number, tags.bool, tags.atom], color: dark ? '#eac18f' : '#83521b' },
    { tag: [tags.comment, tags.meta], color: dark ? '#a5ad9e' : '#606955' },
    { tag: [tags.typeName, tags.tagName, tags.propertyName], color: dark ? '#9bd3ef' : '#165d80' },
    { tag: tags.strong, fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: [tags.invalid, tags.deleted], color: dark ? '#ff9b9b' : '#a02525' },
  ])),
  EditorView.contentAttributes.of({ 'aria-label': 'file contents' }),
];

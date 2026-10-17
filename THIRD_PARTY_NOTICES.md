# Third-party notices

Agent Studio includes material from the projects below. Each is used under its own
license, reproduced or linked here.

## Visual Studio Code

Source: https://github.com/microsoft/vscode

Used in Agent Studio:

- `src/renderer/src/vscode-css/agentsessionsviewer.css` (copied verbatim)
- `src/renderer/src/assets/letterpress-light.svg`
- The Light Modern / Dark Modern theme palettes, git decoration colours, and
  tree, list, and sash metrics ported into the renderer's styles
- The `vs/base` tree and list widgets, used through the `monaco-editor` package

```
MIT License

Copyright (c) 2015 - present Microsoft Corporation

All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Codicons

Source: https://github.com/microsoft/vscode-codicons

Used in Agent Studio: `src/renderer/src/assets/codicon.ttf` and the codepoints in
`src/renderer/src/codicon.css`.

Copyright (c) Microsoft Corporation. The icons are licensed under the
[Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/)
license (CC BY 4.0).

## Seti UI

Source: https://github.com/jesseweed/seti-ui

Used in Agent Studio: `src/renderer/src/assets/seti.woff` (the file icons).

```
Copyright (c) 2014 Jesse Weed

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## npm dependencies

Packages installed from npm (Electron, Monaco, xterm.js, ssh2, node-pty, the ACP
adapter, …) keep their own licenses, found in each package under `node_modules/`.
The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is not open source: it is
© Anthropic PBC and its use is subject to
[Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance).

# sitekit

Small building blocks used by the internal docs portal. No dependencies, no framework.

| Module | Exports | Purpose |
| --- | --- | --- |
| `src/static-server.js` | `resolveStaticPath(rootDir, requestPath)`, `readStaticFile(rootDir, requestPath)` | Map a request path (as received in the URL, possibly percent-encoded, possibly with a query string) to a file under the public root and read it. |
| `src/upload.js` | `isAllowedUpload(name)`, `sanitizeFilename(name)`, `saveUpload(uploadDir, originalName, data)` | Store user uploaded images, text files and PDFs in the upload directory. |
| `src/merge.js` | `deepMerge(target, source)` | Merge plain objects recursively into `target` (arrays and scalars are replaced) and return it. |
| `src/config.js` | `loadConfig(jsonText, defaults)` | Parse a JSON config file and layer it over the defaults. |
| `src/template.js` | `render(template, data)` | Fill `{{ path.to.value }}` placeholders in an HTML template. |
| `src/auth.js` | `verifyToken(provided, expected)`, `isAllowedOrigin(origin, allowList)` | API token check and CORS origin allow-list. |

The portal runs on Windows and Linux hosts.

Run the tests with `npm test` (no install needed).

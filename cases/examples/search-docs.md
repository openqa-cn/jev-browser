# 搜索并打开文档

- id: search-docs-md
- start: examples/app/index.html
- goal: 搜索 Pilot 并打开第一篇文档
- tags: smoke, markdown

## Steps
1. Type "Pilot" into searchbox "搜索"
2. Click link "Pilot 入门"
3. Assert url contains `docs.html` and text "入门"

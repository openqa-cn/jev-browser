# 业务知识

按应用存放给决策模型看的业务笔记。通用决策在 `src/policy.ts`，不在这里写某个网站的填字规则。

每篇笔记是一个 Markdown 文件，放在 `knowledge/<app>/` 下，开头用这段头信息：

```yaml
---
app: ctrip
title: 携程国内机票
hosts:
  - ctrip.com
keywords:
  - 携程
  - 出发地
---
```

`hosts` 用来对启动 URL 的域名。`keywords` 用来对目标语句。头信息里写 `general: true` 的笔记不看域名和关键词，每次规划、决策和填字都会带上。命中的笔记只作为参考。模型仍然只能从当前页的索引里选题。

新增一个应用时加一篇笔记，不要把规则写回 `src/policy.ts`。

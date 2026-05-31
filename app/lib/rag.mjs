const RAG_SKIP_PATTERNS = [
  /^(早上好|早安|早呀|早啊|早|上午好)[哦呀啊啦嘛~～!！。,.，\s]*$/i,
  /^(晚上好|晚安|午安|下午好)[哦呀啊啦嘛~～!！。,.，\s]*$/i,
  /^(你好|您好|在吗|在不在|hello|hi|hey)[哦呀啊啦嘛~～!！。,.，\s]*$/i,
  /^(哈哈+|hhh+|嘿嘿+|嗯+|哦+|啊+)[哦呀啊啦嘛~～!！。,.，\s]*$/i,
];

export function shouldSkipRag(userMessage) {
  const q = userMessage.trim().toLowerCase();
  return !q || (q.length <= 24 && RAG_SKIP_PATTERNS.some(pattern => pattern.test(q)));
}

export function buildRagBody(userMessage, ragContext) {
  if (!ragContext) return userMessage;
  return [
    "【可能相关的背景资料】",
    "以下资料由向量检索自动召回，可能相关，也可能无关。",
    "不要假设用户正在阅读、分享或讨论这些资料；只有当它确实能帮助回答时才使用。",
    "",
    ragContext,
    "",
    "---",
    "",
    userMessage,
  ].join("\n");
}

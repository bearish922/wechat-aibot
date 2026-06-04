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
    "【本轮知识库检索结果】",
    "以下内容来自本地角色知识库。涉及角色事实、关系、时间线、说话方式或当前状态时，应优先参考这些资料。",
    "如果资料与旧印象冲突，以资料中的当前状态、模型规则和明确关系文档为准；如果资料明显无关，可以忽略。",
    "不要把没有检索到的固定设定补编成事实。",
    "",
    ragContext,
    "",
    "---",
    "",
    userMessage,
  ].join("\n");
}

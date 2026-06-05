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

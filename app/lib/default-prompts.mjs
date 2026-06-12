// Global prompt and runtime defaults. Role-scoped prompt defaults live in role-prompts.mjs.

export const DEFAULT_VISION_CAPTION_PROMPT = [
  "请为另一个聊天模型客观解析这张图片，输出中文。",
  "优先识别：画面主体、可见文字/OCR、物品类型、作品名或品牌名、场景、数量/分量。",
  "请区分'看清楚的事实'和'不确定的推测'。不要把推测写成事实。",
  "如果能清楚读出漫画/书/商品的标题，请写出标题；如果读不清，明确说读不清。",
  "如果存在电脑屏幕、桌面、背景物体等，只描述确实入镜且清晰可见的内容。",
  "不要从少量视觉线索脑补作品类型、剧情、人数或用户偏好。",
  "输出 3-6 句；需要时可加一行'低置信度/不确定点'。不要角色扮演。",
].join("\n");

export const DEFAULT_RAG_KEYWORDS = {
  lore: "身高|生日|血型|学校|学部|大学|乐队|成员|经历|过去|以前|曾经|关系|朋友|队友|同伴|互动|称呼|设定|资料|官方|剧情|假唱|退团|作品|歌曲|角色|几岁|多大|多高|哪里|哪儿",
  names: "长崎素世|千早爱音|丸山彩|白鹭千圣|素世|爱音|小彩|MyGO|CRYCHIC|Pastel\\*Palettes|PasPale",
};

// ─── 默认行为参数 ──────────────────────────────────────────────

export const DEFAULT_VISIBLE_CONTEXT_TURNS = 8;
export const DEFAULT_PROACTIVE_CHECK_INTERVAL_MS = 20000;
export const DEFAULT_PROACTIVE_COOLDOWN_MS = 1800000;
export const DEFAULT_PROACTIVE_DAILY_MAX = 8;
export const DEFAULT_DAILY_SHARE_SEED_INTERVAL_MS = 2700000;
export const DEFAULT_DAILY_SHARE_MIN_IDLE_MS = 1800000;
export const DEFAULT_PROACTIVE_DEFAULT_EXPIRY_OFFSET_MS = 1800000;
export const DEFAULT_DAILY_SHARE_DEFAULT_SCHEDULE_OFFSET_MS = 300000;
export const DEFAULT_DAILY_SHARE_DEFAULT_EXPIRY_OFFSET_MS = 1800000;
export const DEFAULT_DAILY_SHARE_DEFAULT_CANCEL_IF = ["用户已经开启新话题"];

export const DEFAULT_RAG_TOP_K = 6;
export const DEFAULT_RAG_MIN_SCORE = 0.48;
export const DEFAULT_RAG_RESULT_MAX_CHARS = 3600;
export const DEFAULT_RAG_TIMEOUT_MS = 45000;

export const DEFAULT_SCHEDULE_CHECK_INTERVAL_MS = 86400000;
export const DEFAULT_SCHEDULE_FINALIZATION_TIMEOUT_MS = 60000;
export const DEFAULT_SCHEDULE_RECENT_KINDS_LIMIT = 5;
export const DEFAULT_SCHEDULE_BASIS_MAX_LENGTH = 300;
export const DEFAULT_SCHEDULE_ARC_TITLE_MAX_LENGTH = 80;
export const DEFAULT_SCHEDULE_EXPIRY_AFTER_END_BUFFER_MS = 43200000;
export const DEFAULT_SCHEDULE_DEFAULT_EXPIRY_FROM_NOW_MS = 259200000;

export const DEFAULT_HIDDEN_WORLD_MAX_PENDING_INTENTS = 8;

export const DEFAULT_CHUNK_SEND_DELAY_MS = 450;
export const DEFAULT_MAX_CANCEL_REASON_LENGTH = 500;

export const DEFAULT_TURN_RESET_THRESHOLD = 16;
export const DEFAULT_STATE_STALE_THRESHOLD_MS = 1800000;

// 日本季节/月历知识库（按月索引）
export const DEFAULT_SEASONAL_MONTHLY_NOTES = {
  "1": ["新年氛围，初诣参拜、贺年卡、压岁钱", "成人礼（1月第2个周一），各地举办成人式", "寒冷严冬，北部有雪，东京偶尔积雪"],
  "2": ["节分（2月3日前后），撒豆驱鬼、吃惠方卷", "情人节（2月14日），女生送义理或本命巧克力", "考试季，大学入学共通考试后期", "札幌雪祭（2月上旬）"],
  "3": ["女儿节/雏祭（3月3日），桃花节，女孩的节日", "白色情人节（3月14日），情人节回礼", "春分/彼岸周，扫墓祭祖", "毕业季（3月中下旬），樱花初绽预告", "春假开始（3月下旬～4月初）"],
  "4": ["樱花季（3月下旬～4月中旬），赏樱胜地热闹非凡", "入学式/入社式（4月初），新学期开始，职场新人入职", "花祭（4月8日）", "新年度的开始，生活节奏变化期"],
  "5": ["黄金周（4月29日～5月5日前后），大型连休，旅游出行高峰", "儿童节/端午（5月5日），挂鲤鱼旗", "新绿季节，气候宜人，户外活动增多", "神田祭（5月中旬，隔年大祭），三社祭（5月第3个周末）"],
  "6": ["入梅（6月上旬～中旬），闷热多雨，出行不便", "夏越祓（6月30日），穿过茅草环驱除半年晦气", "紫阳花盛开，镰仓、箱根赏花人潮涌动"],
  "7": ["出梅（7月中旬前后），正式入夏", "七夕（7月7日），各地七夕祭，挂短册许愿", "京都祇园祭（7月整月，山鉾巡行17日），日本三大祭之一", "天神祭（7月24-25日），大阪天满宫，船渡御和奉纳花火", "暑假开始（7月下旬～8月末），学生出游增多", "花火大会季开始，各地周末均有烟花表演"],
  "8": ["盛夏酷暑，台风季高峰期", "盂兰盆节（8月13-15日），返乡高峰，祭祖、盆舞", "青森睡魔祭（8月2-7日），秋田竿灯（8月3-6日），仙台七夕（8月6-8日）", "阿波舞（8月12-15日），夜来祭（8月9-12日）", "花火大会各地持续，暑期返程高峰"],
  "9": ["残暑持续，台风季尾声", "白银周（敬老日+秋分连休，约5天连休）", "中秋明月/十五夜（9月中旬～10月上旬），吃月见团子", "运动会季节（9～10月），体育日改称运动日"],
  "10": ["秋季红叶季开始，出游赏秋", "运动日（10月第2个周一），三连休", "万圣节（10月31日），涩谷等地变装活动", "大学学园祭季节（10～11月），各大学文化祭集中举办"],
  "11": ["红叶季高峰，赏枫时节", "文化日（11月3日）", "七五三（11月15日），3岁5岁7岁儿童参拜神社", "勤劳感谢日（11月23日），三连休", "酉市（11月酉日），买熊手等吉祥物"],
  "12": ["忘年会季节（12月），聚餐增多", "圣诞节（12月24-25日），日本传统是KFC炸鸡+蛋糕", "年末大扫除", "除夕（12月31日），吃跨年荞麦面，寺院敲钟108下", "寒假（12月下旬～1月中旬），返乡或旅行"],
};

export function normalizeRagKeywords(value = {}) {
  const lore = String(value?.lore ?? "").trim() || DEFAULT_RAG_KEYWORDS.lore;
  const names = String(value?.names ?? "").trim() || DEFAULT_RAG_KEYWORDS.names;
  return {
    lore,
    names,
  };
}

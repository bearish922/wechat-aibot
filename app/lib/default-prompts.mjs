// 全局 prompt 与运行时默认参数。角色级 prompt 默认值在 role-prompts.mjs 中定义。

// ─── 图片解析 prompt ──────────────────────────────────────────
// 发给视觉模型的系统指令，要求客观解析图片供后续聊天模型使用
export const DEFAULT_VISION_CAPTION_PROMPT = [
  "请为另一个聊天模型客观解析这张图片，输出中文。",
  "优先识别：画面主体、可见文字/OCR、物品类型、作品名或品牌名、场景、数量/分量。",
  "请区分'看清楚的事实'和'不确定的推测'。不要把推测写成事实。",
  "如果能清楚读出漫画/书/商品的标题，请写出标题；如果读不清，明确说读不清。",
  "如果存在电脑屏幕、桌面、背景物体等，只描述确实入镜且清晰可见的内容。",
  "不要从少量视觉线索脑补作品类型、剧情、人数或用户偏好。",
  "输出 3-6 句；需要时可加一行'低置信度/不确定点'。不要角色扮演。",
].join("\n");

// ─── RAG 记忆检索关键词 ─────────────────────────────────────
// lore: 世界观/设定类关键词，用于检索角色背景资料
// names: 角色名关键词，用于检索特定角色的记忆文档
export const DEFAULT_RAG_KEYWORDS = {
  lore: "身高|生日|血型|学校|学部|大学|乐队|成员|经历|过去|以前|曾经|关系|朋友|队友|同伴|互动|称呼|设定|资料|官方|剧情|假唱|退团|作品|歌曲|角色|几岁|多大|多高|哪里|哪儿|花咲川|羽丘|庆鹏|四叶|月之森|CiRCLE|RiNG|PasPale|Pastel.*Palettes|Roselia|Afterglow|PoPiPa|Poppin.*Party|HHW|Hello.*Happy.*World|Morfonica|RAS|Raise.*Suilen|MyGO|Ave.*Mujica|CRYCHIC",
  names: "长崎素世|千早爱音|丸山彩|白鹭千圣|梦中的千圣|素世|爱音|小彩|伊芙|麻弥|日菜|纱夜|薰|花音|育美|有咲|香澄|多惠|沙绫|里美|美咲|心|灯|友希那|莉莎|亚子|燐子|巴|摩卡|兰|鸫|绯玛丽|透子|筑紫|瑠唯|真白|六花|LOCK|LAYER|MASKING|PAREO|CHU2|乐奈|立希|海铃|若麦|睦|祥子|MyGO|CRYCHIC|Pastel\\*Palettes|Roselia|Afterglow|PoPiPa|Poppin.*Party|HHW|Hello.*Happy.*World|Morfonica|RAS|Raise.*Suilen|Ave.*Mujica",
};

// ─── 默认行为参数 ──────────────────────────────────────────────

// 可见对话历史的最大轮数（每轮 = user + assistant 各一条）
export const DEFAULT_VISIBLE_CONTEXT_TURNS = 8;
// 主动消息检查间隔（毫秒），定时扫描是否有待发送的主动消息
export const DEFAULT_PROACTIVE_CHECK_INTERVAL_MS = 20000;
// 主动消息冷却时间（毫秒），上次发送后多久内不再次发送
export const DEFAULT_PROACTIVE_COOLDOWN_MS = 1800000;
// 每日主动消息发送上限（自然日）
export const DEFAULT_PROACTIVE_DAILY_MAX = 8;
// 每日分享种子生成间隔（毫秒），每隔多久生成一次日常分享候选
export const DEFAULT_DAILY_SHARE_SEED_INTERVAL_MS = 2700000;
// 每日分享最小空闲时间（毫秒），用户持续不活跃多久后才考虑发送
export const DEFAULT_DAILY_SHARE_MIN_IDLE_MS = 1800000;
// 主动消息默认过期偏移（毫秒），到期未发送则作废
export const DEFAULT_PROACTIVE_DEFAULT_EXPIRY_OFFSET_MS = 1800000;
// 每日分享候选的默认调度偏移（毫秒），距 seed 生成后多久触发
export const DEFAULT_DAILY_SHARE_DEFAULT_SCHEDULE_OFFSET_MS = 300000;
// 每日分享候选的默认过期偏移（毫秒），到期未发送则作废
export const DEFAULT_DAILY_SHARE_DEFAULT_EXPIRY_OFFSET_MS = 1800000;
// 每日分享默认取消条件列表（自然语言描述）
export const DEFAULT_DAILY_SHARE_DEFAULT_CANCEL_IF = ["用户已经开启新话题"];

// RAG 记忆检索：返回条数上限
export const DEFAULT_RAG_TOP_K = 6;
// RAG 记忆检索：最低相似度分数阈值
export const DEFAULT_RAG_MIN_SCORE = 0.48;
// RAG 单条结果最大字符数
export const DEFAULT_RAG_RESULT_MAX_CHARS = 3600;
// RAG 检索调用超时（毫秒）
export const DEFAULT_RAG_TIMEOUT_MS = 45000;

// 日程检查间隔（毫秒），默认 24 小时
export const DEFAULT_SCHEDULE_CHECK_INTERVAL_MS = 86400000;
// 日程最终确认超时（毫秒），超时未确认的日程候选丢弃
export const DEFAULT_SCHEDULE_FINALIZATION_TIMEOUT_MS = 60000;
// 近期日程种类去重窗口（条数），同种类不会重复创建
export const DEFAULT_SCHEDULE_RECENT_KINDS_LIMIT = 5;
// 日程候选依据文本最大长度（字符）
export const DEFAULT_SCHEDULE_BASIS_MAX_LENGTH = 300;
// 日程弧线标题最大长度（字符）
export const DEFAULT_SCHEDULE_ARC_TITLE_MAX_LENGTH = 80;
// 日程结束后的过期缓冲时间（毫秒），避免刚结束就被清理
export const DEFAULT_SCHEDULE_EXPIRY_AFTER_END_BUFFER_MS = 43200000;
// 日程从创建到默认过期的时间（毫秒），默认 3 天
export const DEFAULT_SCHEDULE_DEFAULT_EXPIRY_FROM_NOW_MS = 259200000;


// 消息分块发送间隔（毫秒），避免连续发送过快
export const DEFAULT_CHUNK_SEND_DELAY_MS = 450;
// 取消原因文本最大长度（字符）
export const DEFAULT_MAX_CANCEL_REASON_LENGTH = 500;

// 回合计数器阈值，达到后触发场景重置 + 记忆批量更新
export const DEFAULT_CONTEXT_RESET_RATIO = 0.5;
export const DEFAULT_TURN_RESET_THRESHOLD = 30;
// 状态过期阈值（毫秒），超时未更新的世界状态视为过期
export const DEFAULT_STATE_STALE_THRESHOLD_MS = 1800000;

// ─── 日本季节/月历知识库（按月索引）────────────────────────
// 用于注入当前月份的季节感知上下文，帮助角色做出符合时节的回应
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

// 规范化 RAG 关键词对象，缺失字段退回到 DEFAULT_RAG_KEYWORDS 默认值
// 参数: value - 部分或完整的关键词对象 { lore?, names? }
// 返回: 规范化后的 { lore, names } 对象
export function normalizeRagKeywords(value = {}) {
  const lore = String(value?.lore ?? "").trim() || DEFAULT_RAG_KEYWORDS.lore;
  const names = String(value?.names ?? "").trim() || DEFAULT_RAG_KEYWORDS.names;
  return {
    lore,
    names,
  };
}

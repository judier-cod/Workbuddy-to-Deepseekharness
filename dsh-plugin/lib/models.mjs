/**
 * 桥的模型目录 → dsh 的模型元数据。
 *
 * 桥的 `/v1/models` 是「OpenAI 模型对象 + 项目自加的字段」：
 *   id, name, context_window, max_output_tokens, credits, supports_images,
 *   vendor, tags, description_zh, description_en, badge, free
 * 这里只做一次单向映射，保证「模型选择器里看到的上下文 / 输出上限 / 多模态」
 * 与桥上「可用模型」面板里的数字**同源**，不会两处各说一套。
 */

/** 已知的非对话模型（桥的目录层已过滤过一轮，这里是第二道保险）。 */
const NON_CHAT_PATTERNS = [
  /embedding/i,
  /rerank/i,
  /^text-moderation/i,
  /tts/i,
  /whisper/i,
  /image-generation/i,
];

export function isChatModel(id) {
  return !NON_CHAT_PATTERNS.some((re) => re.test(String(id)));
}

/**
 * 把消耗倍率写成「0.11×」这样的短标记。
 *
 * 为什么需要：dsh 的模型选择器**只渲染 `name`**（`description` 在 `listModels`
 * 里虽被放行，但前端不显示），所以倍率只能编进展示名。倍率是选模型时最该看见
 * 的东西 —— 同样的活，0.11 与 2.2 差 20 倍，看不见就是盲选。
 *
 * 只在倍率是**有限数字**时产出标记；拿不到就返回空串。
 *
 * 刻意不用 `Number(value)` 直接判零：`Number('')`、`Number(null)` 都是 0，
 * 那会把「上游没给倍率」误标成「免费」——**标错价比不标价更糟**，用户会以为
 * 白嫖而放心调用。所以先做类型与空值判定，再谈数值。
 */
export function creditTag(credits, free) {
  // 显式的免费标记最可信，优先采信。
  if (free === true) return '免费';
  let n = null;
  if (typeof credits === 'number' && Number.isFinite(credits)) n = credits;
  else if (typeof credits === 'string' && credits.trim() !== '') {
    const parsed = Number(credits);
    if (Number.isFinite(parsed)) n = parsed;
  }
  if (n === null) return '';
  if (n === 0) return '免费';
  if (n < 0) return '';
  // 去掉多余的小数尾：0.50 → 0.5，1.00 → 1。倍率本身精度不高，两位足够。
  const text = String(Math.round(n * 100) / 100);
  return `${text}×`;
}

/**
 * 把倍率标记拼到展示名后面。
 *
 * 只动 `name`，绝不碰 `id` —— id 是路由键，改了就调不到模型。
 */
export function withCreditTag(name, credits, free) {
  const tag = creditTag(credits, free);
  return tag ? `${name} · ${tag}` : name;
}

/**
 * 促销徽章 → 要不要编进展示名。
 *
 * 只有**用户看了会改主意**的才标：免费类（夜间免费 / 限时免费）与降价类
 * （夜间折扣 / 错峰）。像「新上线」「推荐」这种营销文案一律不标 ——
 * 展示名已经带模型名 + 倍率，再塞噪音反而看不清价。
 *
 * 另外 dedupe：若徽章文字已经把倍率说清楚了（例如 badge="夜间折扣" 且倍率
 * 就是折后价），仍然要标 —— 因为用户得知道**为什么**这个价比平时低，
 * 否则会以为模型一直这么便宜（第二天白天发现变贵就会觉得"显示不准"）。
 *
 * @param {string} badge 上游促销徽章文案
 * @returns {boolean}
 */
export function isPriceBadge(badge) {
  const text = String(badge || '').trim();
  if (!text) return false;
  // 免费类
  if (/免费/i.test(text)) return true;
  if (/^free(\s|$)/i.test(text)) return true;
  // 降价 / 时段类
  if (/折扣|错峰|降价|优惠|半价|限时/i.test(text)) return true;
  return false;
}

/**
 * 把「倍率 + 促销徽章」拼成展示名后缀。
 *
 * 形如：
 *   `GLM-5.2 · 0.4×（夜间折扣）`      倍率 + 时段说明
 *   `Hy3 · 免费（限时免费）`           明确是活动免费
 *   `Hy4 preview · 免费`              免费但上游没说是活动 —— **不编造来源**
 *
 * **免费无促销来源时不加说明**：实测国际版目录里 `hy4-preview` / `hy3` 就是
 * `credits: 0` 且没有任何促销标注。上游没说永久还是活动，我们就不能替它写
 * "限时免费" —— 编错会让人误判（以为随时会变，或反过来以为永远免费）。
 *
 * @param {string} name 展示名（模型名）
 * @param {number|string} credits 生效倍率
 * @param {boolean} free 促销是否明确标记为免费
 * @param {string} badge 促销徽章文案
 */
export function withCreditTagAndBadge(name, credits, free, badge) {
  const tag = creditTag(credits, free);
  const promo = isPriceBadge(badge) ? String(badge).trim() : '';
  if (!tag && !promo) return name;
  // 倍率已说清"免费"时不再重复同一句话，只在促销给了**不同**说明时才补
  if (tag && promo && promo !== tag) return `${name} · ${tag}（${promo}）`;
  if (tag) return `${name} · ${tag}`;
  return `${name} · ${promo}`;
}

/**
 * 判断一个模型是否支持图片输入。
 *
 * 默认**以上游目录为准**，但允许用 `visionOverrides` 覆盖 —— 因为上游目录
 * 会漏报：实测国际版账号下 `deepseek-v4.1-flash` 的 `supports_images` 是空的
 * （国内版同一模型为 true），而该模型在国际版客户端里**确实能看图**。
 * 照搬目录字段会让用户在 DSH 里贴不了图。
 *
 * 覆盖是**双向**的：
 *   - `true`  → 强制声明支持（目录漏报时用）
 *   - `false` → 强制声明不支持（目录误报时用）
 * 未列出的模型一律按目录走，不猜。
 *
 * @param {object} model 桥上 `/v1/models` 的一项
 * @param {Record<string, boolean>} [overrides] 模型 id → 是否支持图片
 */
export function supportsImages(model, overrides) {
  const id = String(model?.id ?? '');
  if (overrides && typeof overrides === 'object' && typeof overrides[id] === 'boolean') {
    return overrides[id];
  }
  return model?.supports_images === true || model?.images === true;
}

/**
 * 取模型的消耗倍率，允许用 `creditOverrides` 覆盖。
 *
 * 为什么需要：上游目录会**漏报倍率**。实测国际版目录里 `deepseek-v4.1-flash`
 * 连 `credits` 字段都没有，但用 10811 tokens 实测（三次累计 32433 tokens）扣分
 * **恒为 0** —— 它在国际版下是真免费。目录漏报导致展示名光秃秃没有价，用户
 * 既不敢用（怕贵），又不知道它免费。
 *
 * 语义**只收非负数**：`0` = 免费，正数 = 直接采用。负数 / NaN / 非数字一律忽略
 * （按目录走）—— 宁可不标，也不标一个负数。
 *
 * @param {object} model 桥上 `/v1/models` 的一项
 * @param {Record<string, number>} [overrides] 模型 id → 倍率（0 = 免费）
 * @returns {{ credits: number|string|undefined, free: boolean }}
 */
export function effectiveCredits(model, overrides) {
  const id = String(model?.id ?? '');
  const raw = overrides?.[id];
  /**
   * 先排除空值再谈数值 —— `Number('')` / `Number(null)` / `Number([])` 都是 0，
   * 直接判数值会把"没填"误当成"免费"，**标错价比不标价更糟**（用户以为白嫖）。
   */
  const blank = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
  if (!blank) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return { credits: n, free: n === 0 };
  }
  // 目录值 + 促销免费标记（桥已把时段判断与折扣因子算进 credits）
  return { credits: model?.credits, free: model?.free === true };
}

/**
 * 把桥的一个模型对象翻译成 dsh 适配器的模型元数据。
 * @param {object} model 桥上 `/v1/models` 的一项
 * @param {{ showCredits?: boolean, visionOverrides?: Record<string, boolean> }} [options]
 */
export function toAdapterModel(model, options = {}) {
  const id = String(model.id);
  const contextWindow = Number(model.context_window || model.contextWindow || 0) || undefined;
  const maxTokens = Number(model.max_output_tokens || model.maxTokens || 0) || undefined;
  const images = supportsImages(model, options.visionOverrides);
  // 推理能力：桥以 supports_reasoning（上游 supportsReasoning 的透传）标记；
  // 兼容直接给 reasoning:true 的旧形状。
  const reasoning = model.supports_reasoning === true || model.supportsReasoning === true || model.reasoning === true;
  const baseName = String(model.name || id);
  /** 促销徽章：桥给了字段级 badge（如「夜间折扣」），也可能在 tags 里（旧宿主）。 */
  const badge = String(model.badge || '').trim()
    || (Array.isArray(model.tags) ? model.tags : [])
      .map((t) => String(t).replace(/^badge:/i, '').split(':')[0].trim())
      .find(Boolean)
    || '';
  const { credits, free } = effectiveCredits(model, options.creditOverrides);
  const name = options.showCredits
    ? withCreditTagAndBadge(baseName, credits, free, badge)
    : baseName;
  return {
    id,
    name,
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    inputModalities: images ? ['text', 'image'] : ['text'],
    ...(reasoning ? { reasoning: true } : {}),
  };
}

/**
 * 目录 → 适配器模型列表。
 * @param {Array<object>} catalog 桥 `/v1/models?all=1` 的 data
 * @param {{ allow?: string[], deny?: string[], showCredits?: boolean, visionOverrides?: Record<string, boolean>, creditOverrides?: Record<string, number> }} [filter]
 */
export function toAdapterModels(catalog, filter = {}) {
  const allow = new Set((filter.allow || []).map(String));
  const deny = new Set((filter.deny || []).map(String));
  const seen = new Set();
  const out = [];
  for (const raw of catalog || []) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
    if (!isChatModel(raw.id)) continue;
    if (allow.size > 0 && !allow.has(raw.id)) continue;
    if (deny.has(raw.id)) continue;
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    out.push(toAdapterModel(raw, {
      showCredits: filter.showCredits === true,
      visionOverrides: filter.visionOverrides,
      creditOverrides: filter.creditOverrides,
    }));
  }
  return out;
}

/** 桥侧的完整目录（含 credits / vendor 等展示字段），给面板与工具用。 */
export function toDirectory(catalog) {
  return (catalog || [])
    .filter((m) => m && typeof m.id === 'string' && isChatModel(m.id))
    .map((m) => {
      // 上游把促销徽章混在 tags 里，形如 `badge:限时免费:#FF0000`。
      // 直接当标签显示就是一条噪音（而且把颜色丢了），所以这里拆出来：
      //   - 干净的标签 → tags
      //   - 结构化的徽章（label + color）→ badges，前端可渲染成带色小胶囊
      const tags = [];
      const badges = [];
      for (const raw of Array.isArray(m.tags) ? m.tags : []) {
        const text = String(raw);
        const match = /^badge:(.+?)(?::(#[0-9a-fA-F]{3,8}))?$/.exec(text);
        if (match) badges.push({ label: match[1], color: match[2] || null });
        else tags.push(text);
      }
      // 桥另外给了字段级 badge（促销标签），补进去并去重
      if (m.badge && !badges.some((b) => b.label === String(m.badge))) {
        badges.push({ label: String(m.badge), color: null });
      }
      return {
        id: m.id,
        name: String(m.name || m.id),
        contextWindow: Number(m.context_window || 0) || null,
        maxTokens: Number(m.max_output_tokens || 0) || null,
        images: m.supports_images === true,
        credits: typeof m.credits === 'number' ? m.credits : null,
        free: m.free === true,
        // 上游的厂商标识是单字母代码（f/j/v/e…），不是名字；原样保留但由界面
        // 标注为"标识"，免得被当成厂商名
        vendor: m.vendor ? String(m.vendor) : null,
        badge: m.badge ? String(m.badge) : (badges[0]?.label ?? null),
        badges,
        description: String(m.description_zh || m.description_en || ''),
        tags,
      };
    });
}

/** 面板/工具里的默认推荐模型：优先免费/精选，其次上下文最大的那个。 */
export function pickDefaultModel(catalog) {
  const list = (catalog || []).filter((m) => m && typeof m.id === 'string' && isChatModel(m.id));
  if (!list.length) return null;
  const preferred = ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'glm-5.3', 'kimi-k3', 'hy4-preview'];
  for (const id of preferred) {
    if (list.some((m) => m.id === id)) return id;
  }
  const free = list.find((m) => m.free === true || m.credits === 0);
  if (free) return free.id;
  return [...list].sort((a, b) => Number(b.context_window || 0) - Number(a.context_window || 0))[0].id;
}

/** 把毫秒时长写成「3 小时 12 分」这样的短文本。 */
export function humanDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0 分';
  const totalMinutes = Math.floor(n / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days} 天`);
  if (hours) parts.push(`${hours} 小时`);
  if (!days && minutes) parts.push(`${minutes} 分`);
  return parts.join(' ') || '不到 1 分';
}

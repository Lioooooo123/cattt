import * as THREE from 'three';

export type TimeSlot = 'dawn' | 'day' | 'dusk' | 'evening' | 'night';
export type Weather = 'clear' | 'rain';

export const SLOT_NAMES: Record<TimeSlot, string> = {
  dawn: '清晨',
  day: '白天',
  dusk: '黄昏',
  evening: '傍晚',
  night: '夜晚',
};
export const WEATHER_NAMES: Record<Weather, string> = { clear: '晴', rain: '下着雨' };

/** 一个预设 = 这一组数。时段之间、晴雨之间都是整组插值。 */
export interface Sky {
  top: THREE.Color;
  horizon: THREE.Color;
  /** 主光：白天是太阳，入夜是月亮 */
  light: THREE.Color;
  lightIntensity: number;
  /** 主光方位角、仰角（度）。方位 0 = 从镜头这边照过去，正值偏右 */
  azimuth: number;
  elevation: number;
  fill: THREE.Color;
  ground: THREE.Color;
  fillIntensity: number;
  /** 以下都是 0–1 的可见度／强度 */
  windowLit: number;
  sun: number;
  /** 太阳那一侧地平线上的暖光。太阳落下去以后（傍晚）圆盘没了，余晖还在，所以和 sun 分开 */
  glow: number;
  moon: number;
  stars: number;
  rain: number;
  /** 雾：清晨和雨天浓 */
  mist: number;
  /** 团子自己发一点光（按贴图）：入夜后蓝光照橙毛会发黑，靠它把团子托回橙色。和 iOS 给猫单独一层乘色是一个意思 */
  catGlow: number;
  exposure: number;
}

const c = (hex: string) => new THREE.Color(hex);

// 天色初值取 iOS 量过的数（Atmosphere.swift 注释里的 A1–A4 与白天首页），第二轮按 3D 光照重调：
// 白天的天比量到的更饱和一点（iOS 毛毡天空是 #35b0f0 一路）；入夜把补光抬高，免得毛毡吃光后一片死黑。
const PRESETS: Record<TimeSlot, Sky> = {
  dawn: {
    top: c('#8cc4e6'), horizon: c('#f6dcc4'), light: c('#ffd9b0'), lightIntensity: 1.9, azimuth: -66, elevation: 16,
    fill: c('#dfe9f4'), ground: c('#a9b089'), fillIntensity: 1.35, windowLit: 0.3, sun: 0.7, glow: 0.7, moon: 0, stars: 0, rain: 0, mist: 0.55, catGlow: 0.04, exposure: 1,
  },
  day: {
    top: c('#65a5cf'), horizon: c('#c4dfeb'), light: c('#fff0da'), lightIntensity: 2.8, azimuth: -34, elevation: 46,
    fill: c('#dceafa'), ground: c('#7c936d'), fillIntensity: 1.1, windowLit: 0, sun: 0, glow: 0, moon: 0, stars: 0, rain: 0, mist: 0.04, catGlow: 0, exposure: 1,
  },
  dusk: {
    top: c('#9a5f9a'), horizon: c('#f7a873'), light: c('#ffc49a'), lightIntensity: 1.25, azimuth: 62, elevation: 12,
    fill: c('#b8a4c8'), ground: c('#5f7048'), fillIntensity: 1.1, windowLit: 0.55, sun: 1, glow: 1, moon: 0, stars: 0.05, rain: 0, mist: 0.12, catGlow: 0.14, exposure: 1,
  },
  // 傍晚和夜晚要一眼分得开（用户 09-17 指出第二轮两者看不出区别，当时夜晚的光反而比傍晚还亮）：
  // 傍晚 = 刚入夜，天还是亮的钴蓝、西边地平线留一道余晖、主光从落日那侧低低打过来，没有月亮，星星刚冒头；
  // 夜晚 = 深夜，天近乎墨蓝、整体暗一档、月亮和满天星，院子靠月光和窗灯。
  evening: {
    top: c('#21469a'), horizon: c('#8a80b8'), light: c('#e0a9b4'), lightIntensity: 1.0, azimuth: 62, elevation: 9,
    fill: c('#93a6e0'), ground: c('#4a5068'), fillIntensity: 1.3, windowLit: 0.9, sun: 0, glow: 0.7, moon: 0, stars: 0.18, rain: 0, mist: 0.1, catGlow: 0.14, exposure: 1.1,
  },
  night: {
    top: c('#051634'), horizon: c('#1c2750'), light: c('#a8bdf0'), lightIntensity: 0.8, azimuth: 30, elevation: 44,
    fill: c('#7185b2'), ground: c('#34445c'), fillIntensity: 1.05, windowLit: 1, sun: 0, glow: 0, moon: 1, stars: 1, rain: 0, mist: 0.06, catGlow: 0.13, exposure: 1.05,
  },
};

/** 一天的关键帧（小时），和 iOS 的 Atmosphere.keyframes 同一张表。 */
const KEYFRAMES: [number, TimeSlot][] = [
  [5.5, 'night'], [6.5, 'dawn'], [8.0, 'day'], [17.0, 'day'], [17.8, 'dusk'], [18.7, 'evening'], [19.8, 'night'],
];

const RAIN_GREY = c('#738190');

function cloneSky(s: Sky): Sky {
  return { ...s, top: s.top.clone(), horizon: s.horizon.clone(), light: s.light.clone(), fill: s.fill.clone(), ground: s.ground.clone() };
}

function mixInto(out: Sky, a: Sky, b: Sky, t: number) {
  out.top.lerpColors(a.top, b.top, t);
  out.horizon.lerpColors(a.horizon, b.horizon, t);
  out.light.lerpColors(a.light, b.light, t);
  out.fill.lerpColors(a.fill, b.fill, t);
  out.ground.lerpColors(a.ground, b.ground, t);
  const keys = ['lightIntensity', 'azimuth', 'elevation', 'fillIntensity', 'windowLit', 'sun', 'glow', 'moon', 'stars', 'rain', 'mist', 'catGlow', 'exposure'] as const;
  for (const key of keys) out[key] = a[key] + (b[key] - a[key]) * t;
}

/** 雨 = 当前时段 × 一层修正：压灰、去太阳、星星归零。和 iOS 同一个思路，不单独做五套。 */
function wet(base: Sky): Sky {
  const s = cloneSky(base);
  const luminance = (col: THREE.Color) => 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b;
  const grey = (col: THREE.Color, amount: number) => {
    const level = Math.max(0.12, luminance(col) / luminance(RAIN_GREY));
    col.lerp(RAIN_GREY.clone().multiplyScalar(Math.min(level, 1.15)), amount);
  };
  grey(s.top, 0.72);
  grey(s.horizon, 0.62);
  grey(s.fill, 0.5);
  grey(s.light, 0.6);
  s.lightIntensity *= 0.4;
  s.fillIntensity *= 0.9;
  s.sun = 0;
  s.glow *= 0.25;
  s.stars = 0;
  s.moon *= 0.3;
  s.rain = 1;
  s.mist = Math.max(s.mist, 0.6);
  // 雨把主光压掉六成，团子跟着暗；补一点回来
  s.catGlow = s.catGlow + 0.05;
  return s;
}

export function slotAt(hour: number): { from: TimeSlot; to: TimeSlot; t: number } {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 0; i < KEYFRAMES.length; i++) {
    const [aHour, a] = KEYFRAMES[i]!;
    const [bHourRaw, b] = KEYFRAMES[(i + 1) % KEYFRAMES.length]!;
    const bHour = bHourRaw < aHour ? bHourRaw + 24 : bHourRaw;
    const hh = h < aHour ? h + 24 : h;
    if (hh >= aHour && hh <= bHour) return { from: a, to: b, t: bHour > aHour ? (hh - aHour) / (bHour - aHour) : 0 };
  }
  return { from: 'night', to: 'night', t: 0 };
}

export function nowHour() {
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
}

const TRANSITION = 3; // 秒，和 iOS 手动切天气的起落一致

/**
 * 天色的状态机：选"跟着现在"或某个时段、晴或雨，3 秒过渡到目标。
 * current 是此刻插值出来的那一组数，世界每帧读它。
 */
export class Atmosphere {
  readonly current: Sky = cloneSky(PRESETS.day);
  /** null = 跟着现在 */
  slot: TimeSlot | null = null;
  weather: Weather = 'clear';
  /** 调试面板可以直接给小时 */
  hourOverride: number | null = null;

  private from: Sky = cloneSky(PRESETS.day);
  private target: Sky = cloneSky(PRESETS.day);
  private elapsed = TRANSITION;

  constructor() {
    this.retarget();
    mixInto(this.current, this.target, this.target, 0);
    mixInto(this.from, this.target, this.target, 0);
  }

  /** 此刻显示的时段名（跟着现在时取较近的那一档） */
  get slotShown(): TimeSlot {
    if (this.slot) return this.slot;
    const { from, to, t } = slotAt(this.hourOverride ?? nowHour());
    return t < 0.5 ? from : to;
  }

  get dark() {
    const { top, horizon } = this.current;
    const l = (col: THREE.Color) => 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b;
    // 首屏的字压在天空上半截，所以主要看天顶的明暗；地平线的余晖只占三成
    return l(top) * 0.7 + l(horizon) * 0.3 < 0.2;
  }

  choose(slot: TimeSlot | null, weather: Weather, instant = false) {
    this.slot = slot;
    this.weather = weather;
    this.from = cloneSky(this.current);
    this.elapsed = instant ? TRANSITION : 0;
    this.retarget();
    if (instant) mixInto(this.current, this.target, this.target, 0);
  }

  update(dt: number) {
    if (!this.slot) this.retarget();
    this.elapsed = Math.min(TRANSITION, this.elapsed + dt);
    const t = this.elapsed / TRANSITION;
    mixInto(this.current, this.from, this.target, t * t * (3 - 2 * t));
  }

  private retarget() {
    let base: Sky;
    if (this.slot) {
      base = PRESETS[this.slot];
    } else {
      const { from, to, t } = slotAt(this.hourOverride ?? nowHour());
      base = cloneSky(PRESETS[from]);
      mixInto(base, PRESETS[from], PRESETS[to], t);
    }
    this.target = this.weather === 'rain' ? wet(base) : cloneSky(base);
  }
}

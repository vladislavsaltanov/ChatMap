// «Нейронный» вид карты: свои шейдерные слои sigma v4.
//  - layerSoma — тело нейрона: капля жидкой ртути с дендритами. Контур «живой»
//    (дышит), от тела отрастают отростки к самым сильным соседям и сливаются с ним
//    мягким метабольным швом (smooth-min SDF). Крупные капли — чёрная ртуть с
//    тонированными бликами (под слово), мелкие — яркие светящиеся «звёзды».
//  - layerAxon — аксон: тонкая светящаяся жила, раструбы у тел (корни дендритов),
//    синаптическая «бусина» посередине сильных связей, градиент между цветами
//    концов, бегущие импульсы (фоном — редко, на подсвеченных связях — непрерывно).
// Чистая визуальная прослойка: данных чата здесь нет и быть не должно.
import { pathCurved, pathLine } from 'sigma/rendering'
import type { EdgeLayer, FragmentLayer } from 'sigma/rendering'

// Общие часы: время в секундах (по модулю — чтобы не терять точность float в шейдере)
export const neuralClock = { t: 0, motion: 1 }

const edgeTime = { name: 'u_time', type: 'float' as const, value: 0 }
const edgeMotion = { name: 'u_motion', type: 'float' as const, value: 1 }

export function setNeuralTime(seconds: number, motion: number): void {
  neuralClock.t = seconds % 7200
  neuralClock.motion = motion
  edgeTime.value = neuralClock.t
  edgeMotion.value = motion
}

// Максимум дендритов на тело (по числу переменных arm0…arm4)
export const MAX_ARMS = 5

export function layerSoma(): FragmentLayer {
  const { FLOAT, UNSIGNED_BYTE } = WebGL2RenderingContext
  // language=GLSL
  const glsl = /*glsl*/ `
float somaSmin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// Сужающийся отросток вдоль +y: радиус r1 у корня (y=0) → r2 на конце (y=h)
float somaCapsule(vec2 p, float r1, float r2, float h) {
  p.x = abs(p.x);
  float b = min((r1 - r2) / h, 0.9);
  float a = sqrt(max(1.0 - b * b, 0.0));
  float k = dot(p, vec2(-b, a));
  if (k < 0.0) return length(p) - r1;
  if (k > a * h) return length(p - vec2(0.0, h)) - r2;
  return dot(p, vec2(a, b)) - r1;
}

// Гнутый отросток: центр-линия — дуга (curve смещает поперечную координату).
// rootPos — точка корня в uv (для ветвей второго порядка — середина главной ветви).
float somaArmBent(vec2 p, vec2 rootPos, float turns, float c, float len, float rootR, float tipR, float wob, float curve) {
  float a = turns * 6.2831853 + wob;
  vec2 dir = vec2(cos(a), sin(a));
  vec2 q = p - rootPos;
  vec2 loc = vec2(dot(q, vec2(-dir.y, dir.x)), dot(q, dir));
  float h = max(len + c * 0.3, 1e-3);
  float u = clamp(loc.y / h, 0.0, 1.0);
  loc.x -= curve * sin(u * 3.14159);
  return somaCapsule(loc, rootR, tipR, h);
}

// Поле расстояния всей капли: «живое» тело + дендриты, сшитые smooth-min
float somaField(vec2 p, float c, float pxu, float coreR, float ph, float t,
                float a0, float a1, float a2, float a3, float a4) {
  float ang = atan(p.y, p.x);
  float wob = 0.045 * sin(3.0 * ang + t * 0.9 + ph * 6.28) + 0.03 * sin(5.0 * ang - t * 1.25 + ph * 11.0);
  float d = length(p) - c * (1.0 + wob);
  float k = max(0.34 * c, 2.2 * pxu);                // ширина «шва» слияния
  float lenMax = (1.0 - c) * 0.9;
  float tipR = max(0.045 * c, 0.6 * pxu);
  float rootR = 0.34 * c;
  float an[5] = float[5](a0, a1, a2, a3, a4);
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float w = smoothstep(3.0 + 2.0 * fi, 6.0 + 2.0 * fi, coreR);   // мелким тоже даём отростки, короче
    if (an[i] >= 0.0 && w > 0.001) {
      float len = lenMax * (1.0 - 0.11 * fi) * (0.72 + 0.28 * fract(sin(ph * 91.7 + fi * 12.9) * 4375.5)) * w;
      float wb = 0.07 * sin(t * 0.7 + fi * 1.7 + ph * 9.0);
      float ma = an[i] * 6.2831853 + wb;
      vec2 md = vec2(cos(ma), sin(ma));
      float curve = (fract(sin(ph * 43.9 + fi * 71.3) * 4375.5) - 0.5) * 0.22;
      float da = somaArmBent(p, md * (c * 0.55), an[i], c, len, rootR * w, tipR, wb, curve);
      d = somaSmin(d, da, k);
      // ветви второго порядка: от середины главной, не веером у корня (веер давал ёжика)
      if (coreR > 12.0 && i < 3) {
        for (int j = -1; j <= 1; j += 2) {
          float fj = float(j);
          float bt = an[i] + fj * 0.075;
          vec2 bRoot = md * (c * 0.55 + len * 0.55);
          float bl = len * 0.42 * (0.8 + 0.2 * fract(sin(ph * 57.3 + fi * 31.7 + fj * 17.1) * 4375.5));
          float bcurve = (fract(sin(ph * 29.7 + fi * 37.9 + fj * 7.3) * 4375.5) - 0.5) * 0.16;
          float bd = somaArmBent(p, bRoot, bt, c, bl, rootR * w * 0.6, tipR, wb * 0.5, bcurve);
          d = somaSmin(d, bd, k * 0.7);
        }
      }
    }
  }
  return d;
}

vec4 layer_soma(vec4 v_somaColor, float v_somaCore, float v_somaGlow, float v_somaPhase,
                float v_somaA0, float v_somaA1, float v_somaA2, float v_somaA3, float v_somaA4,
                float u_time) {
  vec3 col = v_somaColor.rgb;
  vec2 p = context.uv;
  float r = length(p);
  float c = clamp(v_somaCore, 0.08, 0.97);
  float pxu = max(context.pixelToUV, 1e-5);
  float coreR = c / pxu;
  float big = smoothstep(8.0, 17.0, coreR);
  float breathe = 0.95 + 0.05 * sin(u_time * 0.9 + v_somaPhase * 6.2831853) + 0.02 * sin(u_time * 2.3 + v_somaPhase * 11.0);

  float d = somaField(p, c, pxu, coreR, v_somaPhase, u_time, v_somaA0, v_somaA1, v_somaA2, v_somaA3, v_somaA4);
  float dPx = d / pxu;
  float inside = 1.0 - smoothstep(-0.75, 0.75, dPx);

  // гало повторяет форму капли с отростками
  float haloK = max((1.0 - c) * 0.22, 1e-4);
  float halo = exp(-max(d, 0.0) / haloK) * (1.0 - smoothstep(0.78, 1.0, r));
  float haloA = min(halo * 0.32 * v_somaGlow * breathe, 0.85);

  // псевдо-нормаль из градиента поля (прямая разность): центр смотрит на зрителя, край — вбок
  float e = 1.5 * pxu;
  float dx = somaField(p + vec2(e, 0.0), c, pxu, coreR, v_somaPhase, u_time, v_somaA0, v_somaA1, v_somaA2, v_somaA3, v_somaA4) - d;
  float dy = somaField(p + vec2(0.0, e), c, pxu, coreR, v_somaPhase, u_time, v_somaA0, v_somaA1, v_somaA2, v_somaA3, v_somaA4) - d;
  vec2 g = vec2(dx, dy);
  float gl = length(g);
  g = gl > 1e-7 ? g / gl : vec2(0.0);
  float depth = clamp(-d / max(0.9 * c, 1e-4), 0.0, 1.0);
  float edgeK = pow(1.0 - depth, 0.85);
  vec3 n = vec3(g * edgeK, sqrt(max(1.0 - edgeK * edgeK, 0.0)));

  // светящаяся клетка (чёрный хром на тёмном фоне давал невидимое тело-ёжика):
  // светлый блик по центру, цвет автора, френелевский ободок
  vec3 rv = vec3(2.0 * n.z * n.x, 2.0 * n.z * n.y, 2.0 * n.z * n.z - 1.0);
  vec3 sky = mix(vec3(0.78, 0.86, 1.0), col, 0.45);
  vec3 envCol = mix(col * 0.22, sky * 0.8, smoothstep(-0.1, 0.55, rv.y));
  float hl = pow(max(dot(rv, normalize(vec3(-0.5, 0.7, 0.55))), 0.0), 36.0);
  float hl2 = pow(max(dot(rv, normalize(vec3(0.62, -0.55, 0.5))), 0.0), 12.0);
  float fres = pow(1.0 - n.z, 2.2);
  vec3 chrome = envCol + vec3(1.0) * hl * 1.6 + col * hl2 * 0.55 + col * fres * 0.95;

  // тело светится: цвет автора + горячее белое ядро
  vec3 solid = mix(col * 1.15, vec3(1.0), 0.8 * pow(depth, 1.35));
  vec3 fillRgb = mix(solid, chrome, big * 0.45);

  float rim = exp(-(dPx * dPx) / (2.0 * 0.9 * 0.9));
  vec3 rimRgb = mix(col, vec3(1.0), 0.45);
  float rimA = rim * big * 0.75;

  vec3 pm = col * haloA;
  float pa = haloA;
  pm = pm * (1.0 - inside) + fillRgb * inside;
  pa = pa * (1.0 - inside) + inside;
  pm = pm * (1.0 - rimA) + rimRgb * rimA;
  pa = pa * (1.0 - rimA) + rimA;
  return pa > 0.001 ? vec4(pm / pa, pa) : vec4(0.0);
}
`
  return {
    name: 'soma',
    uniforms: [{ name: 'u_time', type: 'float', value: 0 }],
    attributes: [
      { name: 'somaColor', size: 4, type: UNSIGNED_BYTE, normalized: true, source: 'color' },
      { name: 'somaCore', size: 1, type: FLOAT, source: 'core' },
      { name: 'somaGlow', size: 1, type: FLOAT, source: 'glow' },
      { name: 'somaPhase', size: 1, type: FLOAT, source: 'phase' },
      { name: 'somaA0', size: 1, type: FLOAT, source: 'arm0' },
      { name: 'somaA1', size: 1, type: FLOAT, source: 'arm1' },
      { name: 'somaA2', size: 1, type: FLOAT, source: 'arm2' },
      { name: 'somaA3', size: 1, type: FLOAT, source: 'arm3' },
      { name: 'somaA4', size: 1, type: FLOAT, source: 'arm4' },
    ],
    glsl,
    lifecycle: (ctx) => ({
      beforeRender: () => {
        const loc = ctx.getUniformLocation('u_time')
        if (loc) ctx.gl.uniform1f(loc, neuralClock.t)
      },
    }),
  }
}

export function layerAxon(): EdgeLayer {
  const { FLOAT } = WebGL2RenderingContext
  // language=GLSL
  const glsl = /*glsl*/ `
vec4 layer_axon(EdgeContext ctx) {
  float px = max(ctx.aaWidth, 1e-6);                       // ~1 px в единицах сцены
  float halfPx = max(ctx.thickness * 0.5 / px, 1.0);
  float dPx = abs(ctx.sdf + ctx.thickness * 0.5) / px;     // расстояние от осевой, px
  float rel = clamp(dPx / halfPx, 0.0, 1.0);

  // радиус жилы: тонкая посередине, раструб у концов (корни дендритов), «бусина»-синапс в центре
  float L = ctx.edgeLength / px;
  float toEnd = min(ctx.t, 1.0 - ctx.t) * L;
  float rMid = 0.55 + 0.1 * halfPx;
  float flare = max(halfPx * 0.8 - rMid, 0.0);
  float r = rMid + flare * exp(-toEnd / (6.0 + halfPx * 1.5));
  float toMid = abs(ctx.t - 0.5) * L;
  float bw = 1.2 + 0.25 * halfPx;
  r += v_axonBead * halfPx * 0.4 * exp(-(toMid * toMid) / (2.0 * bw * bw));
  r = min(r, halfPx * 0.92);

  float body = 1.0 - smoothstep(r - 0.7, r + 0.7, dPx);
  float u = clamp(dPx / max(r, 0.5), 0.0, 1.0);
  float tube = sqrt(max(1.0 - u * u, 0.0));
  vec3 base = mix(v_sourceColor.rgb, v_targetColor.rgb, ctx.t);
  vec3 tubeRgb = base * (0.55 + 0.45 * tube) + vec3(1.0) * pow(tube, 8.0) * 0.28;

  float glow = exp(-max(dPx - r, 0.0) / max(halfPx * 0.42, 0.9)) * 0.32 * (1.0 - smoothstep(0.65, 1.0, rel));
  float a = body + (1.0 - body) * glow;
  vec3 rgb = a > 0.001 ? (tubeRgb * body + base * glow * (1.0 - body)) / a : base;

  // импульс: фоном — короткое окно в периоде; на активных связях — непрерывно
  float k = step(0.5, v_axonPulse);
  float cyc = fract(u_time * 0.07 + v_axonPhase);
  float ppAmb = cyc / 0.13;
  float onAmb = (1.0 - step(1.0, ppAmb)) * u_motion;
  float ppAct = fract(u_time * 0.4 + v_axonPhase);
  float pp = mix(ppAmb, ppAct, k);
  float gain = mix(onAmb * 0.6, 1.0, k);
  float dAlong = (ctx.t - pp) * L;                         // px вдоль нити, минус — позади головы
  float sig = dAlong < 0.0 ? 34.0 : 5.0;
  float pulse = exp(-(dAlong * dAlong) / (2.0 * sig * sig)) * gain;
  // второй выстрел по активным жилам: слабый отголосок полпериода спустя
  if (k > 0.5) {
    float pp2 = fract(u_time * 0.4 + v_axonPhase + 0.5);
    float d2 = (ctx.t - pp2) * L;
    pulse += exp(-(d2 * d2) / 50.0) * 0.8;
  }

  vec3 hot = mix(base, vec3(1.0), 0.85);
  rgb = mix(rgb, hot, clamp(pulse, 0.0, 1.0) * 0.85);
  a = clamp(a + pulse * (body + 0.7 * glow) * 0.9, 0.0, 1.0);
  return vec4(rgb, a);
}
`
  return {
    name: 'axon',
    uniforms: [edgeTime, edgeMotion],
    attributes: [
      { name: 'a_axonPulse', size: 1, type: FLOAT, source: 'pulse', defaultValue: 0 },
      { name: 'a_axonPhase', size: 1, type: FLOAT, source: 'phase', defaultValue: 0 },
      { name: 'a_axonBead', size: 1, type: FLOAT, source: 'bead', defaultValue: 0 },
    ],
    needsNodeColors: true,
    glsl,
  }
}

export const NEURAL_PRIMITIVES = {
  nodes: {
    layers: [layerSoma()],
    variables: {
      core: { type: 'number', default: 0.5 },
      glow: { type: 'number', default: 1 },
      phase: { type: 'number', default: 0 },
      arm0: { type: 'number', default: -1 },
      arm1: { type: 'number', default: -1 },
      arm2: { type: 'number', default: -1 },
      arm3: { type: 'number', default: -1 },
      arm4: { type: 'number', default: -1 },
    },
  },
  edges: {
    // Нити-дуги: line нужен как дефолтный путь, curved — рабочий (кривизна — атрибут ребра)
    paths: [pathLine(), pathCurved()],
    layers: [layerAxon()],
    variables: {
      pulse: { type: 'number', default: 0 },
      phase: { type: 'number', default: 0 },
      bead: { type: 'number', default: 0 },
    },
  },
} as const

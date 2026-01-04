import { extractPaletteLinearSRGB } from './palette';

type Mode = 'sph' | 'pbf' | 'mpm';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const imgInput = document.getElementById('img') as HTMLInputElement;
const modeSel = document.getElementById('mode') as HTMLSelectElement;
const quality = document.getElementById('quality') as HTMLInputElement;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;
const paletteEl = document.getElementById('palette') as HTMLDivElement;

function setStatus(msg: string, ok = true) {
  statusEl.innerHTML = `<span class="${ok ? 'ok' : 'bad'}">${ok ? '●' : '●'}</span> ${msg}`;
}

function particleCountFromQuality(q: number) {
  // 1..10 -> 8k..64k-ish
  const base = 8192;
  return Math.min(65536, Math.max(4096, Math.floor(base * (q / 2))));
}

function drawPalette(p: Float32Array) {
  paletteEl.innerHTML = '';
  for (let i = 0; i < 6; i++) {
    const r = p[i * 4 + 0];
    const g = p[i * 4 + 1];
    const b = p[i * 4 + 2];
    const div = document.createElement('div');
    div.className = 'swatch';
    div.style.background = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
    paletteEl.appendChild(div);
  }
}

function mat4Identity() {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

function mat4Mul(a: Float32Array, b: Float32Array) {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      o[r * 4 + c] =
        a[r * 4 + 0] * b[0 * 4 + c] +
        a[r * 4 + 1] * b[1 * 4 + c] +
        a[r * 4 + 2] * b[2 * 4 + c] +
        a[r * 4 + 3] * b[3 * 4 + c];
    }
  }
  return o;
}

function mat4Perspective(fovy: number, aspect: number, near: number, far: number) {
  const f = 1.0 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

function mat4LookAt(eye: [number, number, number], at: [number, number, number], up: [number, number, number]) {
  const ex = eye[0], ey = eye[1], ez = eye[2];
  const ax = at[0], ay = at[1], az = at[2];
  let zx = ex - ax, zy = ey - ay, zz = ez - az;
  const zl = Math.hypot(zx, zy, zz) || 1;
  zx /= zl; zy /= zl; zz /= zl;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  const xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl; xy /= xl; xz /= xl;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  const m = new Float32Array(16);
  m[0] = xx; m[1] = yx; m[2] = zx; m[3] = 0;
  m[4] = xy; m[5] = yy; m[6] = zy; m[7] = 0;
  m[8] = xz; m[9] = yz; m[10] = zz; m[11] = 0;
  m[12] = -(xx * ex + xy * ey + xz * ez);
  m[13] = -(yx * ex + yy * ey + yz * ez);
  m[14] = -(zx * ex + zy * ey + zz * ez);
  m[15] = 1;
  return m;
}

async function main() {
  if (!('gpu' in navigator)) {
    setStatus('WebGPU not available. Use Chrome/Edge with WebGPU enabled.', false);
    return;
  }

  setStatus('Requesting GPU device…');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No GPU adapter');
  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();
  setStatus('WebGPU ready.');

  const context = canvas.getContext('webgpu') as GPUCanvasContext;
  context.configure({ device, format, alphaMode: 'opaque' });

  // ---- Load shaders ----
  const [
    simWGSL,
    depthWGSL,
    reconWGSL,
    compWGSL,
    sprayWGSL,
    sceneBuildWGSL,
    sceneDebWGSL,
  ] = await Promise.all([
    fetch('/src/webgpu/sim.wgsl').then(r => r.text()),
    fetch('/src/webgpu/particles_depth.wgsl').then(r => r.text()),
    fetch('/src/webgpu/reconstruct.wgsl').then(r => r.text()),
    fetch('/src/webgpu/composite.wgsl').then(r => r.text()),
    fetch('/src/webgpu/spray.wgsl').then(r => r.text()),
    fetch('/src/webgpu/scene_buildings.wgsl').then(r => r.text()),
    fetch('/src/webgpu/scene_debris.wgsl').then(r => r.text()),
  ]);

  const simModule = device.createShaderModule({ code: simWGSL });
  const depthModule = device.createShaderModule({ code: depthWGSL });
  const reconModule = device.createShaderModule({ code: reconWGSL });
  const compModule = device.createShaderModule({ code: compWGSL });
  const sprayModule = device.createShaderModule({ code: sprayWGSL });
  const sceneBuildModule = device.createShaderModule({ code: sceneBuildWGSL });
  const sceneDebModule = device.createShaderModule({ code: sceneDebWGSL });

  // ---- State ----
  let mode: Mode = modeSel.value as Mode;
  let particleCount = particleCountFromQuality(parseInt(quality.value, 10));

  // ---- Buffers ----
  // Params: 8 vec4 = 128 bytes
  const paramsBuf = device.createBuffer({
    size: 8 * 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Palette uniform (6 vec4)
  const paletteBuf = device.createBuffer({
    size: 6 * 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Camera buffer: view, proj, vp + params0 + params1
  const cameraBuf = device.createBuffer({
    size: 16 * 4 * 3 + 16 * 2,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Camera params for reconstruction/composite (tanHalfFov, aspect, near, far)
  const camParamsBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Particles: pos vec4 + vel vec4 (32 bytes)
  const particlesBuf = device.createBuffer({
    size: 32 * 65536,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // Hash grid buffers
  const MAX_CELLS = 128 * 64 * 128;
  const cellHeadsBuf = device.createBuffer({
    size: MAX_CELLS * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const nextBuf = device.createBuffer({
    size: 65536 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const densityBuf = device.createBuffer({
    size: 65536 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const pressureBuf = device.createBuffer({
    size: 65536 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // Buildings + flags
  const bDimX = 64;
  const bDimZ = 64;
  const bCount = bDimX * bDimZ;

  const buildingsBuf = device.createBuffer({
    size: bCount * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const buildFlagsBuf = device.createBuffer({
    size: bCount * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // Debris
  const debrisMax = 32768;
  const debrisBuf = device.createBuffer({
    size: debrisMax * 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const debrisCountBuf = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  // Building grid uniforms (for rendering + indexing)
  const bGridBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bStepBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  // ---- Offscreen textures ----
  let sceneTex: GPUTexture;
  let depthTex: GPUTexture;
  let thicknessTex: GPUTexture;
  let smoothDepthTex: GPUTexture;
  let normalTex: GPUTexture;
  let mistTex: GPUTexture;

  function createOffscreen() {
    const w = Math.max(1, canvas.width);
    const h = Math.max(1, canvas.height);

    sceneTex = device.createTexture({
      size: [w, h],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    depthTex = device.createTexture({
      size: [w, h],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    thicknessTex = device.createTexture({
      size: [w, h],
      format: 'r32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    smoothDepthTex = device.createTexture({
      size: [w, h],
      format: 'r16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });

    normalTex = device.createTexture({
      size: [w, h],
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });

    mistTex = device.createTexture({
      size: [w, h],
      format: 'r8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      context.configure({ device, format, alphaMode: 'opaque' });
      createOffscreen();
      rebuildBindGroupsAfterOffscreen();
    }
  }

  // ---- Pipelines & bind groups ----
  // SIM bind group
  const simBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-write-storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-write-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-write-storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-write-storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-write-storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-write-storage' } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-write-storage' } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-write-storage' } },
      { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-write-storage' } },
    ],
  });

  const simPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [simBindGroupLayout] });

  const clearPipeline = device.createComputePipeline({ layout: simPipelineLayout, compute: { module: simModule, entryPoint: 'clearCells' } });
  const buildPipeline = device.createComputePipeline({ layout: simPipelineLayout, compute: { module: simModule, entryPoint: 'buildGrid' } });
  const densityPipeline = device.createComputePipeline({ layout: simPipelineLayout, compute: { module: simModule, entryPoint: 'densityPass' } });
  const forcePipeline = device.createComputePipeline({ layout: simPipelineLayout, compute: { module: simModule, entryPoint: 'forcePass' } });
  const debrisPipeline = device.createComputePipeline({ layout: simPipelineLayout, compute: { module: simModule, entryPoint: 'updateDebris' } });

  const simBindGroup = device.createBindGroup({
    layout: simBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: paramsBuf } },
      { binding: 1, resource: { buffer: particlesBuf } },
      { binding: 2, resource: { buffer: cellHeadsBuf } },
      { binding: 3, resource: { buffer: nextBuf } },
      { binding: 4, resource: { buffer: densityBuf } },
      { binding: 5, resource: { buffer: pressureBuf } },
      { binding: 6, resource: { buffer: buildingsBuf } },
      { binding: 7, resource: { buffer: buildFlagsBuf } },
      { binding: 8, resource: { buffer: debrisBuf } },
      { binding: 9, resource: { buffer: debrisCountBuf } },
    ],
  });

  // Scene pipelines (buildings + debris) into sceneTex
  const sceneSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

  const sceneBuildBGL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
    ],
  });
  const sceneDebBGL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });

  const sceneBuildPL = device.createPipelineLayout({ bindGroupLayouts: [sceneBuildBGL] });
  const sceneDebPL = device.createPipelineLayout({ bindGroupLayouts: [sceneDebBGL] });

  const blend: GPUBlendState = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };

  const sceneBuildPipeline = device.createRenderPipeline({
    layout: sceneBuildPL,
    vertex: { module: sceneBuildModule, entryPoint: 'vsMain' },
    fragment: { module: sceneBuildModule, entryPoint: 'fsMain', targets: [{ format: 'rgba8unorm', blend }] },
    primitive: { topology: 'point-list' },
  });

  const sceneDebPipeline = device.createRenderPipeline({
    layout: sceneDebPL,
    vertex: { module: sceneDebModule, entryPoint: 'vsMain' },
    fragment: { module: sceneDebModule, entryPoint: 'fsMain', targets: [{ format: 'rgba8unorm', blend }] },
    primitive: { topology: 'point-list' },
  });

  const sceneBuildBG = device.createBindGroup({
    layout: sceneBuildBGL,
    entries: [
      { binding: 0, resource: { buffer: cameraBuf } },
      { binding: 1, resource: { buffer: buildingsBuf } },
      { binding: 2, resource: { buffer: paletteBuf } },
      { binding: 3, resource: { buffer: bGridBuf } },
      { binding: 4, resource: { buffer: bStepBuf } },
    ],
  });

  const sceneDebBG = device.createBindGroup({
    layout: sceneDebBGL,
    entries: [
      { binding: 0, resource: { buffer: cameraBuf } },
      { binding: 1, resource: { buffer: debrisBuf } },
      { binding: 2, resource: { buffer: paletteBuf } },
    ],
  });

  // Water depth/thickness prepass pipeline
  const depthBGL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });
  const depthPL = device.createPipelineLayout({ bindGroupLayouts: [depthBGL] });

  const depthPipeline = device.createRenderPipeline({
    layout: depthPL,
    vertex: { module: depthModule, entryPoint: 'vsMain' },
    fragment: { module: depthModule, entryPoint: 'fsMain', targets: [{ format: 'r32float', blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } } }] },
    primitive: { topology: 'point-list' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
  });

  const depthBindGroup = device.createBindGroup({
    layout: depthBGL,
    entries: [
      { binding: 0, resource: { buffer: cameraBuf } },
      { binding: 1, resource: { buffer: particlesBuf } },
    ],
  });

  // Reconstruction compute
  const reconBGL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r16float' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const reconPL = device.createPipelineLayout({ bindGroupLayouts: [reconBGL] });
  const reconPipeline = device.createComputePipeline({ layout: reconPL, compute: { module: reconModule, entryPoint: 'main' } });

  // Spray compute
  const sprayBGL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r8unorm' } },
    ],
  });
  const sprayPL = device.createPipelineLayout({ bindGroupLayouts: [sprayBGL] });
  const sprayPipeline = device.createComputePipeline({ layout: sprayPL, compute: { module: sprayModule, entryPoint: 'main' } });

  // Composite pipeline (fullscreen)
  const compBGL = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ],
  });
  const compPL = device.createPipelineLayout({ bindGroupLayouts: [compBGL] });
  const compPipeline = device.createRenderPipeline({
    layout: compPL,
    vertex: { module: compModule, entryPoint: 'vsMain' },
    fragment: { module: compModule, entryPoint: 'fsMain', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });

  let reconBindGroup: GPUBindGroup;
  let sprayBindGroup: GPUBindGroup;
  let compBindGroup: GPUBindGroup;

  function rebuildBindGroupsAfterOffscreen() {
    reconBindGroup = device.createBindGroup({
      layout: reconBGL,
      entries: [
        { binding: 0, resource: depthTex.createView() },
        { binding: 1, resource: thicknessTex.createView() },
        { binding: 2, resource: smoothDepthTex.createView() },
        { binding: 3, resource: normalTex.createView() },
        { binding: 4, resource: { buffer: camParamsBuf } },
      ],
    });

    sprayBindGroup = device.createBindGroup({
      layout: sprayBGL,
      entries: [
        { binding: 0, resource: normalTex.createView() },
        { binding: 1, resource: smoothDepthTex.createView() },
        { binding: 2, resource: thicknessTex.createView() },
        { binding: 3, resource: mistTex.createView() },
      ],
    });

    compBindGroup = device.createBindGroup({
      layout: compBGL,
      entries: [
        { binding: 0, resource: normalTex.createView() },
        { binding: 1, resource: smoothDepthTex.createView() },
        { binding: 2, resource: mistTex.createView() },
        { binding: 3, resource: { buffer: paletteBuf } },
        { binding: 4, resource: { buffer: camParamsBuf } },
        { binding: 5, resource: sceneSampler },
        { binding: 6, resource: sceneTex.createView() },
      ],
    });
  }

  // ---- Init data ----
  let palette = new Float32Array([
    0.92, 0.95, 1.00, 1,
    0.35, 0.70, 0.95, 1,
    0.10, 0.18, 0.30, 1,
    0.06, 0.30, 0.55, 1,
    0.02, 0.06, 0.10, 1,
    0.85, 0.90, 0.95, 1,
  ]);

  function uploadPalette(p: Float32Array) {
    device.queue.writeBuffer(paletteBuf, 0, p);
  }

  function initParticles() {
    const data = new Float32Array(65536 * 8);
    const nx = 96;
    const ny = 24;
    const nz = 48;
    let idx = 0;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (idx >= particleCount) break;
          const px = -3.4 + x * 0.06;
          const py = -0.2 + y * 0.06;
          const pz = -1.6 + z * 0.06;
          data[idx * 8 + 0] = px;
          data[idx * 8 + 1] = py;
          data[idx * 8 + 2] = pz;
          data[idx * 8 + 3] = 1;
          data[idx * 8 + 4] = 0;
          data[idx * 8 + 5] = 0;
          data[idx * 8 + 6] = 0;
          data[idx * 8 + 7] = 0;
          idx++;
        }
      }
    }
    device.queue.writeBuffer(particlesBuf, 0, data);
    // Clear debris + count
    device.queue.writeBuffer(debrisBuf, 0, new Float32Array(debrisMax * 8));
    device.queue.writeBuffer(debrisCountBuf, 0, new Uint32Array([0]));
  }

  function initBuildings(coastX: number) {
    const b = new Float32Array(bCount * 4);
    const flags = new Uint32Array(bCount);
    const originX = coastX + 0.25;
    const originZ = -2.6;
    const cs = 0.08;

    for (let iz = 0; iz < bDimZ; iz++) {
      for (let ix = 0; ix < bDimX; ix++) {
        const id = ix + iz * bDimX;
        const x = originX + (ix + 0.5) * cs;
        const z = originZ + (iz + 0.5) * cs;

        // Dense neighborhood around z ~ 0, taper outwards
        const zFalloff = Math.exp(-Math.abs(z) * 0.75);
        const xBand = x < (coastX + 1.8) ? 1 : 0;

        let h = 0;
        if (xBand) {
          const rnd = (Math.sin(id * 12.9898) * 43758.5453) % 1;
          h = (0.25 + 1.3 * Math.max(0, rnd)) * zFalloff;
        }

        const health = h > 0 ? 1.0 : 0.0;

        b[id * 4 + 0] = h;       // height
        b[id * 4 + 1] = health;  // health
        b[id * 4 + 2] = 0.0;     // destroyed
        b[id * 4 + 3] = 0.0;
        flags[id] = 0;
      }
    }
    device.queue.writeBuffer(buildingsBuf, 0, b);
    device.queue.writeBuffer(buildFlagsBuf, 0, flags);

    device.queue.writeBuffer(bGridBuf, 0, new Float32Array([bDimX, bDimZ, originX, originZ]));
    device.queue.writeBuffer(bStepBuf, 0, new Float32Array([cs, cs, 0, 0]));
  }

  // Camera
  const fov = (55 * Math.PI) / 180;
  const near = 0.05;
  const far = 80.0;

  function updateCamera(nowMs: number) {
    const t = nowMs;
    const aspect = canvas.width / canvas.height;

    const eye: [number, number, number] = [-2.5 + Math.sin(t * 0.00025) * 0.2, 1.8, 6.2];
    const at: [number, number, number] = [1.6, 0.7, 0.0];
    const view = mat4LookAt(eye, at, [0, 1, 0]);
    const proj = mat4Perspective(fov, aspect, near, far);
    const vp = mat4Mul(proj, view);

    // Pack: view(16) + proj(16) + vp(16) + params0(4) + params1(4)
    const out = new Float32Array(16 * 3 + 8);
    out.set(view, 0);
    out.set(proj, 16);
    out.set(vp, 32);

    const tanHalfFov = Math.tan(fov / 2);
    out[48] = tanHalfFov;
    out[49] = aspect;
    out[50] = near;
    out[51] = far;

    out[52] = canvas.height;
    out[53] = 0.06; // particle radius for depth pass
    out[54] = 0;
    out[55] = 0;

    device.queue.writeBuffer(cameraBuf, 0, out);
    device.queue.writeBuffer(camParamsBuf, 0, new Float32Array([tanHalfFov, aspect, near, far]));
  }

  // Params update
  function updateSimParams(dt: number, timeSec: number) {
    // World/grid
    const origin = [-4.0, -0.5, -4.0];
    const dimX = 128;
    const dimY = 64;
    const dimZ = 128;
    const totalCells = dimX * dimY * dimZ;
    const cellSize = 0.16;

    // Fluid
    const restDensity = 1.0;
    const gasK = 1.4;
    const viscosity = 0.02;
    const h = 0.20;

    // Forces/world
    const gravityY = -9.0;
    const damping = 0.05;
    const waveStrength = 1.6;
    const floorY = -0.65;

    const coastX = 1.6;
    const coastSlope = 0.35;
    const bounce = 0.25;
    const friction = 0.25;

    // Buildings
    initBuildingsOnce(coastX);

    const bOriginX = coastX + 0.25;
    const bOriginZ = -2.6;
    const bCell = 0.08;

    const damageScale = 1.25;

    // Pack 8 vec4 = 32 floats
    const buf = new Float32Array(32);
    buf[0] = dt;
    buf[1] = timeSec;
    buf[2] = particleCount;
    buf[3] = mode === 'sph' ? 0 : (mode === 'pbf' ? 1 : 2);

    buf[4] = gravityY;
    buf[5] = damping;
    buf[6] = waveStrength;
    buf[7] = floorY;

    buf[8] = dimX;
    buf[9] = dimY;
    buf[10] = dimZ;
    buf[11] = totalCells;

    buf[12] = origin[0];
    buf[13] = origin[1];
    buf[14] = origin[2];
    buf[15] = cellSize;

    buf[16] = restDensity;
    buf[17] = gasK;
    buf[18] = viscosity;
    buf[19] = h;

    buf[20] = coastX;
    buf[21] = coastSlope;
    buf[22] = bounce;
    buf[23] = friction;

    buf[24] = bDimX;
    buf[25] = bDimZ;
    buf[26] = bOriginX;
    buf[27] = bOriginZ;

    buf[28] = bCell;
    buf[29] = bCell;
    buf[30] = damageScale;
    buf[31] = debrisMax;

    device.queue.writeBuffer(paramsBuf, 0, buf);
  }

  let buildingsInitialized = false;
  function initBuildingsOnce(coastX: number) {
    if (buildingsInitialized) return;
    initBuildings(coastX);
    buildingsInitialized = true;
  }

  // ---- UI ----
  modeSel.addEventListener('change', () => (mode = modeSel.value as Mode));

  quality.addEventListener('change', () => {
    particleCount = particleCountFromQuality(parseInt(quality.value, 10));
    buildingsInitialized = false;
    initParticles();
    setStatus(`Quality set: ${particleCount.toLocaleString()} particles`);
  });

  resetBtn.addEventListener('click', () => {
    buildingsInitialized = false;
    initParticles();
    setStatus('Reset.');
  });

  imgInput.addEventListener('change', async () => {
    const file = imgInput.files?.[0];
    if (!file) return;
    setStatus('Extracting palette…');
    try {
      palette = await extractPaletteLinearSRGB(file, 6);
      uploadPalette(palette);
      drawPalette(palette);
      setStatus('Palette applied.');
    } catch (e) {
      console.error(e);
      setStatus('Palette extraction failed.', false);
    }
  });

  // ---- Bootstrap ----
  resize();
  createOffscreen();
  rebuildBindGroupsAfterOffscreen();

  initParticles();
  uploadPalette(palette);
  drawPalette(palette);

  let last = performance.now();

  function frame(now: number) {
    resize();
    const dt = Math.min(0.02, (now - last) / 1000);
    last = now;

    updateCamera(now);
    updateSimParams(dt, now / 1000);

    const encoder = device.createCommandEncoder();

    // --- SIMULATION ---
    {
      const pass = encoder.beginComputePass();
      pass.setBindGroup(0, simBindGroup);

      pass.setPipeline(clearPipeline);
      pass.dispatchWorkgroups(Math.ceil(MAX_CELLS / 256));

      pass.setPipeline(buildPipeline);
      pass.dispatchWorkgroups(Math.ceil(particleCount / 256));

      pass.setPipeline(densityPipeline);
      pass.dispatchWorkgroups(Math.ceil(particleCount / 256));

      pass.setPipeline(forcePipeline);
      pass.dispatchWorkgroups(Math.ceil(particleCount / 256));

      // debris update
      pass.setPipeline(debrisPipeline);
      pass.dispatchWorkgroups(Math.ceil(debrisMax / 256));

      pass.end();
    }

    // --- SCENE PASS (buildings + debris) into sceneTex ---
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: sceneTex.createView(),
            clearValue: { r: 0.05, g: 0.07, b: 0.10, a: 1.0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });

      pass.setPipeline(sceneBuildPipeline);
      pass.setBindGroup(0, sceneBuildBG);
      pass.draw(bCount, 1, 0, 0);

      pass.setPipeline(sceneDebPipeline);
      pass.setBindGroup(0, sceneDebBG);
      pass.draw(debrisMax, 1, 0, 0);

      pass.end();
    }

    // --- DEPTH + THICKNESS PREPASS (water) ---
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: thicknessTex.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: depthTex.createView(),
          depthClearValue: 1.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
      });

      pass.setPipeline(depthPipeline);
      pass.setBindGroup(0, depthBindGroup);
      pass.draw(particleCount, 1, 0, 0);
      pass.end();
    }

    // --- RECONSTRUCT surface (depth -> smooth depth + normals) ---
    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(reconPipeline);
      pass.setBindGroup(0, reconBindGroup);
      pass.dispatchWorkgroups(Math.ceil(canvas.width / 8), Math.ceil(canvas.height / 8));
      pass.end();
    }

    // --- MIST / SPRAY synthesis ---
    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(sprayPipeline);
      pass.setBindGroup(0, sprayBindGroup);
      pass.dispatchWorkgroups(Math.ceil(canvas.width / 8), Math.ceil(canvas.height / 8));
      pass.end();
    }

    // --- COMPOSITE ---
    {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      });
      pass.setPipeline(compPipeline);
      pass.setBindGroup(0, compBindGroup);
      pass.draw(3, 1, 0, 0);
      pass.end();
    }

    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch((e) => {
  console.error(e);
  setStatus('Fatal error. See console.', false);
});

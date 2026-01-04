// Deluge WebGPU + UI shell (plain JS version of the phase5 demo with UI wiring)

// --- DOM helpers ---
const canvas = document.getElementById('c');
const statusEl = document.getElementById('status');
const paneMap = document.getElementById('pane-map');
const navTabs = document.querySelectorAll('.nav-btn');
const panes = document.querySelectorAll('.pane');
const statsDeaths = document.getElementById('stat-deaths');
const statsDestruction = document.getElementById('stat-destruction');
const timeSlider = document.getElementById('time-slider');
const btnBackpedal = document.getElementById('btn-backpedal');
const btnAdvance = document.getElementById('btn-advance');
const controlsSatellite = document.getElementById('controls-satellite');
const controlsSettings = document.getElementById('controls-settings');
const godStats = document.getElementById('god-stats');

function setStatus(msg, ok = true) {
  if (!statusEl) return;
  statusEl.innerHTML = `<span class="${ok ? 'ok' : 'bad'}">${ok ? '●' : '×'}</span> ${msg}`;
}

// --- Small helpers to reduce monolith size ---
async function loadShaderModules() {
  const shaderNames = [
    'sim.wgsl',
    'particles_depth.wgsl',
    'reconstruct.wgsl',
    'composite.wgsl',
    'spray.wgsl',
    'scene_buildings.wgsl',
    'scene_debris.wgsl',
  ];
  const codes = await Promise.all(
    shaderNames.map((n) => {
      const url = new URL(`./webgpu/${n}`, window.location.href).toString();
      return fetch(url).then((r) => r.text());
    })
  );
  return {
    simModule: codes[0],
    depthModule: codes[1],
    reconModule: codes[2],
    compModule: codes[3],
    sprayModule: codes[4],
    sceneBuildModule: codes[5],
    sceneDebModule: codes[6],
  };
}

function createCoreBuffers(device, MAX_PARTICLES, maxCells, bDimX, bDimZ, debrisMax) {
  const paramsBuf = device.createBuffer({ size: 8 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const paletteBuf = device.createBuffer({ size: 6 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const cameraBuf = device.createBuffer({ size: 16 * 4 * 3 + 16 * 2, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const camParamsBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const particlesBuf = device.createBuffer({ size: 32 * MAX_PARTICLES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const cellHeadsBuf = device.createBuffer({ size: maxCells * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const nextBuf = device.createBuffer({ size: MAX_PARTICLES * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const densityBuf = device.createBuffer({ size: MAX_PARTICLES * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const pressureBuf = device.createBuffer({ size: MAX_PARTICLES * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const bCount = bDimX * bDimZ;
  const buildingsBuf = device.createBuffer({ size: bCount * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const buildFlagsBuf = device.createBuffer({ size: bCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const debrisBuf = device.createBuffer({ size: debrisMax * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const debrisCountBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const bGridBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bStepBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  return {
    paramsBuf,
    paletteBuf,
    cameraBuf,
    camParamsBuf,
    particlesBuf,
    MAX_CELLS: maxCells,
    cellHeadsBuf,
    nextBuf,
    densityBuf,
    pressureBuf,
    bCount,
    buildingsBuf,
    buildFlagsBuf,
    debrisBuf,
    debrisCountBuf,
    bGridBuf,
    bStepBuf,
  };
}

// --- UI wiring ---
function wireTabs() {
  navTabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      navTabs.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.pane;
      panes.forEach((pane) => pane.classList.toggle('hidden', pane.id !== `pane-${target}`));
    });
  });
}

function populateControls() {
  const sliderDef = (label, min, max, step, value, suffix = '', onChange) => {
    const row = document.createElement('div');
    row.className = 'control-row';
    const lbl = document.createElement('div');
    lbl.className = 'control-label';
    lbl.textContent = label;
    const val = document.createElement('div');
    val.className = 'control-value';
    val.textContent = `${value}${suffix}`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('input', () => {
      val.textContent = `${input.value}${suffix}`;
      onChange?.(parseFloat(input.value));
    });
    row.append(lbl, val, input);
    return row;
  };

  const append = (parent, row) => parent && parent.appendChild(row);

  append(controlsSatellite, sliderDef('Water Level', 0, 2, 0.01, 1.0, 'x'));
  append(controlsSatellite, sliderDef('Rain Intensity', 0, 100, 1, 80, '%'));
  append(controlsSatellite, sliderDef('Wave Height', 0, 4, 0.05, 2.5, 'm'));
  append(controlsSatellite, sliderDef('Time Speed', 0.2, 2.0, 0.01, 1.3, 'x'));

  append(controlsSettings, sliderDef('Exposure', 0.5, 2, 0.01, 1.0, 'x'));
  append(controlsSettings, sliderDef('Fog', 0, 1, 0.01, 0.18, ''));
  append(controlsSettings, sliderDef('Spray Density', 0, 1, 0.01, 0.45, ''));
  append(controlsSettings, sliderDef('LOD Aggression', 0, 1, 0.01, 0.4, ''));

  const mkStat = (title, value, accent) => {
    const div = document.createElement('div');
    div.className = 'stat-tile';
    const t = document.createElement('p');
    t.className = 'eyebrow';
    t.textContent = title;
    const v = document.createElement('div');
    v.className = 'value';
    v.style.color = accent;
    v.textContent = value;
    div.append(t, v);
    return div;
  };
  append(godStats, mkStat('Runup Height', '22.4 m', '#4deeea'));
  append(godStats, mkStat('Wave Velocity', '82 km/h', '#74f2ce'));
  append(godStats, mkStat('Inundation Width', '3.1 km', '#ffb347'));
  append(godStats, mkStat('Infrastructure Loss', '68%', '#ff4d6d'));
}

function wireCounters() {
  let deaths = 1245600;
  let destruction = 78.5;

  const updateLabels = () => {
    if (statsDeaths) statsDeaths.textContent = deaths.toLocaleString();
    if (statsDestruction) statsDestruction.textContent = `${destruction.toFixed(1)}%`;
  };
  updateLabels();

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  btnBackpedal?.addEventListener('click', () => {
    deaths = clamp(deaths - 12000, 0, 5_000_000);
    destruction = clamp(destruction - 0.6, 0, 100);
    timeSlider.value = String(Math.max(0, parseFloat(timeSlider.value) - 2));
    updateLabels();
  });

  btnAdvance?.addEventListener('click', () => {
    deaths = clamp(deaths + 18000, 0, 5_000_000);
    destruction = clamp(destruction + 0.8, 0, 100);
    timeSlider.value = String(Math.min(100, parseFloat(timeSlider.value) + 2));
    updateLabels();
  });

  timeSlider?.addEventListener('input', () => {
    const t = parseFloat(timeSlider.value);
    deaths = clamp(600000 + t * 9000, 0, 5_000_000);
    destruction = clamp(42 + t * 0.45, 0, 100);
    updateLabels();
  });
}

// --- WebGPU core (JS-adapted from phase5 demo, fixed palette) ---
async function bootWebGPU() {
  if (!canvas) {
    return;
  }
  if (!('gpu' in navigator)) {
    setStatus('WebGPU not available. Use a modern Chrome/Edge.', false);
    return;
  }
  try {
    setStatus('Requesting GPU device…');
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
    if (!adapter) throw new Error('No GPU adapter');
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    setStatus('WebGPU ready.');

    const shaderSrc = await loadShaderModules();
    const simModule = device.createShaderModule({ code: shaderSrc.simModule });
    const depthModule = device.createShaderModule({ code: shaderSrc.depthModule });
    const reconModule = device.createShaderModule({ code: shaderSrc.reconModule });
    const compModule = device.createShaderModule({ code: shaderSrc.compModule });
    const sprayModule = device.createShaderModule({ code: shaderSrc.sprayModule });
    const sceneBuildModule = device.createShaderModule({ code: shaderSrc.sceneBuildModule });
    const sceneDebModule = device.createShaderModule({ code: shaderSrc.sceneDebModule });

    const MAX_PARTICLES = 32768;
    const mobile = /iphone|android/i.test(navigator.userAgent);
    let particleCount = mobile ? 12000 : 22000;
    const resolutionScale = mobile ? 0.8 : 1;
    const simGrid = mobile
      ? { dimX: 96, dimY: 48, dimZ: 96, cellSize: 0.18, coastX: 1.4 }
      : { dimX: 128, dimY: 64, dimZ: 128, cellSize: 0.16, coastX: 1.6 };
    const MAX_CELLS = simGrid.dimX * simGrid.dimY * simGrid.dimZ;

    // Buffers
    const bDimX = 64, bDimZ = 64;
    const debrisMax = 16384;
    const buffers = createCoreBuffers(device, MAX_PARTICLES, MAX_CELLS, bDimX, bDimZ, debrisMax);
    const {
      paramsBuf,
      paletteBuf,
      cameraBuf,
      camParamsBuf,
      particlesBuf,
      MAX_CELLS,
      cellHeadsBuf,
      nextBuf,
      densityBuf,
      pressureBuf,
      bCount,
      buildingsBuf,
      buildFlagsBuf,
      debrisBuf,
      debrisCountBuf,
      bGridBuf,
      bStepBuf,
    } = buffers;

    // Offscreen targets
    let sceneTex, depthTex, thicknessTex, smoothDepthTex, normalTex, mistTex;
    let sceneView, depthView, thicknessView, smoothDepthView, normalView, mistView;
    const paramsScratch = new Float32Array(32);
    const cameraScratch = new Float32Array(16 * 3 + 8);
    const particleScratch = new Float32Array(MAX_PARTICLES * 8);
    const buildingsScratch = new Float32Array(buffers.bCount * 4);
    const buildingFlagsScratch = new Uint32Array(buffers.bCount);
    function createOffscreen() {
      const w = Math.max(1, canvas.width);
      const h = Math.max(1, canvas.height);
      sceneTex = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      depthTex = device.createTexture({ size: [w, h], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      thicknessTex = device.createTexture({ size: [w, h], format: 'r32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      smoothDepthTex = device.createTexture({ size: [w, h], format: 'r16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
      normalTex = device.createTexture({ size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
      mistTex = device.createTexture({ size: [w, h], format: 'r8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
      sceneView = sceneTex.createView();
      depthView = depthTex.createView();
      thicknessView = thicknessTex.createView();
      smoothDepthView = smoothDepthTex.createView();
      normalView = normalTex.createView();
      mistView = mistTex.createView();
    }

    let needsResize = true;
    let cachedCamParams;
    function resizeIfNeeded() {
      if (!needsResize) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1) * resolutionScale;
      const w = Math.floor(canvas.clientWidth * dpr);
      const h = Math.floor(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        context.configure({ device, format, alphaMode: 'opaque' });
        createOffscreen();
        rebuildBindGroups();
        const tanHalfFov = Math.tan(fov / 2);
        const aspect = w / h;
        cachedCamParams = new Float32Array([tanHalfFov, aspect, near, far]);
        device.queue.writeBuffer(camParamsBuf, 0, cachedCamParams);
      }
      needsResize = false;
    }
    window.addEventListener('resize', () => {
      needsResize = true;
    });

    // Pipelines
    const simBGL = device.createBindGroupLayout({
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
    const simPL = device.createPipelineLayout({ bindGroupLayouts: [simBGL] });
    const clearPipeline = device.createComputePipeline({ layout: simPL, compute: { module: simModule, entryPoint: 'clearCells' } });
    const buildPipeline = device.createComputePipeline({ layout: simPL, compute: { module: simModule, entryPoint: 'buildGrid' } });
    const densityPipeline = device.createComputePipeline({ layout: simPL, compute: { module: simModule, entryPoint: 'densityPass' } });
    const forcePipeline = device.createComputePipeline({ layout: simPL, compute: { module: simModule, entryPoint: 'forcePass' } });
    const debrisPipeline = device.createComputePipeline({ layout: simPL, compute: { module: simModule, entryPoint: 'updateDebris' } });

    const simBG = device.createBindGroup({
      layout: simBGL,
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

    const blend = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    const sceneBuildPL = device.createPipelineLayout({ bindGroupLayouts: [sceneBuildBGL] });
    const sceneDebPL = device.createPipelineLayout({ bindGroupLayouts: [sceneDebBGL] });
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
    const depthBG = device.createBindGroup({
      layout: depthBGL,
      entries: [
        { binding: 0, resource: { buffer: cameraBuf } },
        { binding: 1, resource: { buffer: particlesBuf } },
      ],
    });

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

    let reconBG, sprayBG, compBG;
    function rebuildBindGroups() {
      reconBG = device.createBindGroup({
        layout: reconBGL,
        entries: [
        { binding: 0, resource: depthView },
        { binding: 1, resource: thicknessView },
        { binding: 2, resource: smoothDepthView },
        { binding: 3, resource: normalView },
          { binding: 4, resource: { buffer: camParamsBuf } },
        ],
      });
      sprayBG = device.createBindGroup({
        layout: sprayBGL,
        entries: [
        { binding: 0, resource: normalView },
        { binding: 1, resource: smoothDepthView },
        { binding: 2, resource: thicknessView },
        { binding: 3, resource: mistView },
        ],
      });
      compBG = device.createBindGroup({
        layout: compBGL,
        entries: [
          { binding: 0, resource: normalView },
          { binding: 1, resource: smoothDepthView },
          { binding: 2, resource: mistView },
          { binding: 3, resource: { buffer: paletteBuf } },
          { binding: 4, resource: { buffer: camParamsBuf } },
          { binding: 5, resource: sceneSampler },
          { binding: 6, resource: sceneView },
        ],
      });
    }

    // Init data
    const palette = new Float32Array([
      0.92, 0.95, 1.00, 1,
      0.35, 0.70, 0.95, 1,
      0.10, 0.18, 0.30, 1,
      0.06, 0.30, 0.55, 1,
      0.02, 0.06, 0.10, 1,
      0.85, 0.90, 0.95, 1,
    ]);
    device.queue.writeBuffer(paletteBuf, 0, palette);

    function initParticles() {
      const data = particleScratch;
      const nx = 96, ny = 24, nz = 48;
      let idx = 0;
      for (let z = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
          for (let x = 0; x < nx; x++) {
            if (idx >= particleCount) break;
            data[idx * 8 + 0] = -3.4 + x * 0.06;
            data[idx * 8 + 1] = -0.2 + y * 0.06;
            data[idx * 8 + 2] = -1.6 + z * 0.06;
            data[idx * 8 + 3] = 1;
            idx++;
          }
        }
      }
      device.queue.writeBuffer(particlesBuf, 0, data);
      device.queue.writeBuffer(debrisBuf, 0, new Float32Array(debrisMax * 8));
      device.queue.writeBuffer(debrisCountBuf, 0, new Uint32Array([0]));
    }

    function initBuildings(coastX) {
      const b = buildingsScratch;
      const flags = buildingFlagsScratch;
      const originX = coastX + 0.25;
      const originZ = -2.6;
      const cs = 0.08;
      for (let iz = 0; iz < bDimZ; iz++) {
        for (let ix = 0; ix < bDimX; ix++) {
          const id = ix + iz * bDimX;
          const x = originX + (ix + 0.5) * cs;
          const z = originZ + (iz + 0.5) * cs;
          const zFalloff = Math.exp(-Math.abs(z) * 0.75);
          const xBand = x < (coastX + 1.8) ? 1 : 0;
          let h = 0;
          if (xBand) {
            const rnd = (Math.sin(id * 12.9898) * 43758.5453) % 1;
            h = (0.25 + 1.3 * Math.max(0, rnd)) * zFalloff;
          }
          const health = h > 0 ? 1.0 : 0.0;
          b[id * 4 + 0] = h;
          b[id * 4 + 1] = health;
          b[id * 4 + 2] = 0.0;
          b[id * 4 + 3] = 0.0;
          flags[id] = 0;
        }
      }
      device.queue.writeBuffer(buildingsBuf, 0, b);
      device.queue.writeBuffer(buildFlagsBuf, 0, flags);
      device.queue.writeBuffer(bGridBuf, 0, new Float32Array([bDimX, bDimZ, originX, originZ]));
      device.queue.writeBuffer(bStepBuf, 0, new Float32Array([cs, cs, 0, 0]));
    }

    const fov = (55 * Math.PI) / 180;
    const near = 0.05;
    const far = 80.0;
    function mat4Identity() {
      const m = new Float32Array(16);
      m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
      return m;
    }
    function mat4Mul(a, b) {
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
    function mat4Perspective(fovy, aspect, nearP, farP) {
      const f = 1.0 / Math.tan(fovy / 2);
      const m = mat4Identity();
      m[0] = f / aspect;
      m[5] = f;
      m[10] = (farP + nearP) / (nearP - farP);
      m[11] = -1;
      m[14] = (2 * farP * nearP) / (nearP - farP);
      m[15] = 0;
      return m;
    }
    function mat4LookAt(eye, at, up) {
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
      const m = mat4Identity();
      m[0] = xx; m[1] = yx; m[2] = zx; m[3] = 0;
      m[4] = xy; m[5] = yy; m[6] = zy; m[7] = 0;
      m[8] = xz; m[9] = yz; m[10] = zz; m[11] = 0;
      m[12] = -(xx * ex + xy * ey + xz * ez);
      m[13] = -(yx * ex + yy * ey + yz * ez);
      m[14] = -(zx * ex + zy * ey + zz * ez);
      m[15] = 1;
      return m;
    }

    let buildingsInitialized = false;
    function updateCamera(nowMs) {
      const aspect = cachedCamParams ? cachedCamParams[1] : canvas.width / canvas.height;
      const eye = [-2.5 + Math.sin(nowMs * 0.00025) * 0.2, 1.8, 6.2];
      const at = [1.6, 0.7, 0.0];
      const view = mat4LookAt(eye, at, [0, 1, 0]);
      const proj = mat4Perspective(fov, aspect, near, far);
      const vp = mat4Mul(proj, view);
      const out = cameraScratch;
      out.set(view, 0);
      out.set(proj, 16);
      out.set(vp, 32);
      const tanHalfFov = Math.tan(fov / 2);
      out[48] = tanHalfFov;
      out[49] = aspect;
      out[50] = near;
      out[51] = far;
      out[52] = canvas.height;
      out[53] = 0.06;
      device.queue.writeBuffer(cameraBuf, 0, out);
    }

    function updateSimParams(dt, timeSec) {
      const origin = [-4.0, -0.5, -4.0];
      const dimX = simGrid.dimX;
      const dimY = simGrid.dimY;
      const dimZ = simGrid.dimZ;
      const totalCells = dimX * dimY * dimZ;
      const cellSize = simGrid.cellSize;
      const restDensity = 1.0;
      const gasK = 1.4;
      const viscosity = 0.02;
      const h = 0.20;
      const gravityY = -9.0;
      const damping = 0.05;
      const waveStrength = 1.6;
      const floorY = -0.65;
      const coastX = simGrid.coastX;
      const coastSlope = 0.35;
      const bounce = 0.25;
      const friction = 0.25;

      const bOriginX = coastX + 0.25;
      const bOriginZ = -2.6;
      const bCell = 0.08;
      const damageScale = 1.25;
      const buf = paramsScratch;
      buf[0] = dt;
      buf[1] = timeSec;
      buf[2] = particleCount;
      buf[3] = 0; // mode enum fixed
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

    // Bootstrap
    resizeIfNeeded();
    createOffscreen();
    rebuildBindGroups();
    initParticles();
    initBuildings(simGrid.coastX);
    buildingsInitialized = true;

    let last = performance.now();
    function frame(now) {
      resizeIfNeeded();
      const dt = Math.min(0.02, (now - last) / 1000);
      last = now;
      updateCamera(now);
      updateSimParams(dt, now / 1000);

      const encoder = device.createCommandEncoder();

      // Simulation
      {
        const pass = encoder.beginComputePass();
        pass.setBindGroup(0, simBG);
        pass.setPipeline(clearPipeline);
        pass.dispatchWorkgroups(Math.ceil(MAX_CELLS / 256));
        pass.setPipeline(buildPipeline);
        pass.dispatchWorkgroups(Math.ceil(particleCount / 256));
        pass.setPipeline(densityPipeline);
        pass.dispatchWorkgroups(Math.ceil(particleCount / 256));
        pass.setPipeline(forcePipeline);
        pass.dispatchWorkgroups(Math.ceil(particleCount / 256));
        pass.setPipeline(debrisPipeline);
        pass.dispatchWorkgroups(Math.ceil(debrisMax / 256));
        pass.end();
      }

      // Scene (buildings + debris)
      {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: sceneView,
            clearValue: { r: 0.05, g: 0.07, b: 0.10, a: 1.0 },
            loadOp: 'clear',
            storeOp: 'store',
          }],
        });
        pass.setPipeline(sceneBuildPipeline);
        pass.setBindGroup(0, sceneBuildBG);
        pass.draw(bCount, 1, 0, 0);
        pass.setPipeline(sceneDebPipeline);
        pass.setBindGroup(0, sceneDebBG);
        pass.draw(debrisMax, 1, 0, 0);
        pass.end();
      }

      // Depth + thickness
      {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: thicknessView,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: 'store',
          }],
          depthStencilAttachment: {
            view: depthView,
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        });
        pass.setPipeline(depthPipeline);
        pass.setBindGroup(0, depthBG);
        pass.draw(particleCount, 1, 0, 0);
        pass.end();
      }

      // Reconstruct
      {
        const pass = encoder.beginComputePass();
        pass.setPipeline(reconPipeline);
        pass.setBindGroup(0, reconBG);
        pass.dispatchWorkgroups(Math.ceil(canvas.width / 8), Math.ceil(canvas.height / 8));
        pass.end();
      }

      // Spray
      {
        const pass = encoder.beginComputePass();
        pass.setPipeline(sprayPipeline);
        pass.setBindGroup(0, sprayBG);
        pass.dispatchWorkgroups(Math.ceil(canvas.width / 8), Math.ceil(canvas.height / 8));
        pass.end();
      }

      // Composite
      {
        const pass = encoder.beginRenderPass({
          colorAttachments: [{
            view: context.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          }],
        });
        pass.setPipeline(compPipeline);
        pass.setBindGroup(0, compBG);
        pass.draw(3, 1, 0, 0);
        pass.end();
      }

      device.queue.submit([encoder.finish()]);
      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  } catch (err) {
    console.error(err);
    setStatus(`WebGPU init failed: ${err.message}`, false);
  }
}

// --- Init ---
wireTabs();
populateControls();
wireCounters();
bootWebGPU();

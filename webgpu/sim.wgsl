// WebGPU Tsunami Sim (Phase 5)
// - SPH-ish particles with hash-grid neighbor traversal
// - Building damage + single-shot collapse -> debris spawn
// - Debris update with buoyancy (light floats, heavy sinks-ish)

struct Params {
  u0 : vec4<f32>; // dt, time, particleCount, mode
  u1 : vec4<f32>; // gravityY, damping, waveStrength, floorY
  u2 : vec4<f32>; // dimX, dimY, dimZ, totalCells
  u3 : vec4<f32>; // originX, originY, originZ, cellSize
  u4 : vec4<f32>; // restDensity, gasK, viscosity, h
  u5 : vec4<f32>; // coastX, coastSlope, bounce, friction
  u6 : vec4<f32>; // bDimX, bDimZ, bOriginX, bOriginZ
  u7 : vec4<f32>; // bCellSizeX, bCellSizeZ, damageScale, debrisMax
};

struct Particle {
  pos : vec4<f32>;
  vel : vec4<f32>;
};

struct BuildingCell {
  height : f32;
  health : f32;
  destroyed : f32;
  pad : f32;
};

struct Debris {
  pos : vec4<f32>; // xyz, type (0 light, 1 heavy)
  vel : vec4<f32>; // xyz, alive
};

@group(0) @binding(0) var<uniform> params : Params;
@group(0) @binding(1) var<storage, read_write> particles : array<Particle>;

// Hash-grid linked list for particles
@group(0) @binding(2) var<storage, read_write> cellHeads : array<atomic<i32>>;
@group(0) @binding(3) var<storage, read_write> nextIndex : array<i32>;

@group(0) @binding(4) var<storage, read_write> densityBuf : array<f32>;
@group(0) @binding(5) var<storage, read_write> pressureBuf : array<f32>;

// Buildings + flags
@group(0) @binding(6) var<storage, read_write> buildings : array<BuildingCell>;
@group(0) @binding(7) var<storage, read_write> buildFlags : array<atomic<u32>>;

// Debris + counter
@group(0) @binding(8) var<storage, read_write> debris : array<Debris>;
@group(0) @binding(9) var<storage, read_write> debrisCount : atomic<u32>;

fn cellCoordFromPos(p: vec3<f32>) -> vec3<i32> {
  let origin = params.u3.xyz;
  let cs = params.u3.w;
  let rel = (p - origin) / cs;
  let ix = i32(clamp(floor(rel.x), 0.0, params.u2.x - 1.0));
  let iy = i32(clamp(floor(rel.y), 0.0, params.u2.y - 1.0));
  let iz = i32(clamp(floor(rel.z), 0.0, params.u2.z - 1.0));
  return vec3<i32>(ix, iy, iz);
}

fn cellIndex(c: vec3<i32>) -> u32 {
  let dimX = u32(params.u2.x);
  let dimY = u32(params.u2.y);
  return u32(c.x) + u32(c.y) * dimX + u32(c.z) * dimX * dimY;
}

fn poly6(r: f32, h: f32) -> f32 {
  if (r >= h) { return 0.0; }
  let hr = h - r;
  return 315.0 / (64.0 * 3.14159265 * pow(h, 9.0)) * pow(hr, 3.0);
}

fn spikyGrad(rVec: vec3<f32>, h: f32) -> vec3<f32> {
  let r = length(rVec);
  if (r <= 1e-6 || r >= h) { return vec3<f32>(0.0); }
  let coeff = -45.0 / (3.14159265 * pow(h, 6.0)) * pow(h - r, 2.0);
  return coeff * (rVec / r);
}

fn viscLaplace(r: f32, h: f32) -> f32 {
  if (r >= h) { return 0.0; }
  return 45.0 / (3.14159265 * pow(h, 6.0)) * (h - r);
}

fn hash01(x: u32) -> f32 {
  var n = x;
  n ^= n >> 16;
  n *= 0x7feb352du;
  n ^= n >> 15;
  n *= 0x846ca68bu;
  n ^= n >> 16;
  return f32(n) / 4294967295.0;
}

fn waterSurfaceAt(x: f32, z: f32) -> f32 {
  // A cheap proxy used for debris buoyancy.
  let t = params.u0.y;
  let coastX = params.u5.x;
  let amp = 0.5 + 0.35 * params.u1.z;
  let wave = amp * exp(-0.25 * max(0.0, x - coastX)) * sin(1.2 * t - x * 1.5 + z * 0.2);
  return 0.25 + wave;
}

fn buildingIndexFromXZ(x: f32, z: f32) -> i32 {
  let dimX = i32(params.u6.x);
  let dimZ = i32(params.u6.y);
  let ox = params.u6.z;
  let oz = params.u6.w;
  let csx = params.u7.x;
  let csz = params.u7.y;

  let fx = (x - ox) / csx;
  let fz = (z - oz) / csz;
  let ix = i32(floor(fx));
  let iz = i32(floor(fz));
  if (ix < 0 || iz < 0 || ix >= dimX || iz >= dimZ) { return -1; }
  return ix + iz * dimX;
}

@compute @workgroup_size(256)
fn clearCells(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  let total = u32(params.u2.w);
  if (idx >= total) { return; }
  atomicStore(&cellHeads[idx], -1);
}

@compute @workgroup_size(256)
fn buildGrid(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let count = u32(params.u0.z);
  if (i >= count) { return; }
  let pos = particles[i].pos.xyz;
  let c = cellCoordFromPos(pos);
  let ci = cellIndex(c);
  let prev = atomicExchange(&cellHeads[ci], i32(i));
  nextIndex[i] = prev;
}

@compute @workgroup_size(256)
fn densityPass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let count = u32(params.u0.z);
  if (i >= count) { return; }

  let restDensity = params.u4.x;
  let h = params.u4.w;
  let mass = 1.0;

  let pos = particles[i].pos.xyz;
  let c = cellCoordFromPos(pos);

  var density: f32 = 0.0;
  // Visit 27 neighbor cells
  for (var dz: i32 = -1; dz <= 1; dz = dz + 1) {
    for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
      for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
        let nc = vec3<i32>(c.x + dx, c.y + dy, c.z + dz);
        if (nc.x < 0 || nc.y < 0 || nc.z < 0) { continue; }
        if (nc.x >= i32(params.u2.x) || nc.y >= i32(params.u2.y) || nc.z >= i32(params.u2.z)) { continue; }
        let head = atomicLoad(&cellHeads[cellIndex(nc)]);
        var j: i32 = head;
        var visits: i32 = 0;
        loop {
          if (j < 0 || visits >= 48) { break; }
          let pj = particles[u32(j)].pos.xyz;
          let r = length(pos - pj);
          density = density + mass * poly6(r, h);
          j = nextIndex[u32(j)];
          visits = visits + 1;
        }
      }
    }
  }
  densityBuf[i] = max(density, 1e-4);
  let gasK = params.u4.y;
  pressureBuf[i] = gasK * (densityBuf[i] - restDensity);
}

@compute @workgroup_size(256)
fn forcePass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let count = u32(params.u0.z);
  if (i >= count) { return; }

  let dt = params.u0.x;
  let t = params.u0.y;

  let gravityY = params.u1.x;
  let damping  = params.u1.y;
  let waveStrength = params.u1.z;
  let floorY = params.u1.w;

  let restDensity = params.u4.x;
  let viscosity = params.u4.z;
  let h = params.u4.w;
  let mass = 1.0;

  let coastX = params.u5.x;
  let coastSlope = params.u5.y;
  let bounce = params.u5.z;
  let friction = params.u5.w;

  var p = particles[i];
  var pos = p.pos.xyz;
  var vel = p.vel.xyz;

  let density = densityBuf[i];
  let pressure = pressureBuf[i];

  // External forces
  var force = vec3<f32>(0.0, gravityY * mass, 0.0);

  // Tsunami wave-maker: push from the left, decaying with x
  let wave = waveStrength * exp(-0.18 * max(0.0, pos.x - (coastX - 1.2))) * sin(0.9 * t - pos.x * 0.6);
  force.x = force.x + wave;

  // SPH neighbor forces
  let c = cellCoordFromPos(pos);
  for (var dz: i32 = -1; dz <= 1; dz = dz + 1) {
    for (var dy: i32 = -1; dy <= 1; dy = dy + 1) {
      for (var dx: i32 = -1; dx <= 1; dx = dx + 1) {
        let nc = vec3<i32>(c.x + dx, c.y + dy, c.z + dz);
        if (nc.x < 0 || nc.y < 0 || nc.z < 0) { continue; }
        if (nc.x >= i32(params.u2.x) || nc.y >= i32(params.u2.y) || nc.z >= i32(params.u2.z)) { continue; }
        let head = atomicLoad(&cellHeads[cellIndex(nc)]);
        var j: i32 = head;
        var visits: i32 = 0;
        loop {
          if (j < 0 || visits >= 48) { break; }
          if (u32(j) != i) {
            let q = particles[u32(j)];
            let rVec = pos - q.pos.xyz;
            let r = length(rVec);
            if (r > 1e-6 && r < h) {
              let qDensity = max(densityBuf[u32(j)], 1e-4);
              let qPressure = pressureBuf[u32(j)];
              let grad = spikyGrad(rVec, h);
              let pressureTerm = (pressure + qPressure) / (2.0 * qDensity);
              force = force - mass * pressureTerm * grad;

              let lap = viscLaplace(r, h);
              force = force + viscosity * mass * (q.vel.xyz - vel) / qDensity * lap;
            }
          }
          j = nextIndex[u32(j)];
          visits = visits + 1;
        }
      }
    }
  }

  // Integrate
  vel = vel + (force / max(mass, 1e-6)) * dt;
  vel = vel * (1.0 - damping * dt);
  pos = pos + vel * dt;

  // Coastline rising heightfield collision
  let ground = floorY + max(0.0, pos.x - coastX) * coastSlope;
  if (pos.y < ground) {
    pos.y = ground;
    vel.y = -vel.y * bounce;
    vel.xz = vel.xz * (1.0 - friction);
  }

  // Simple bounds
  if (pos.y < -6.0) { pos.y = -6.0; vel.y = 0.0; }

  // --- Building damage coupling ---
  let bid = buildingIndexFromXZ(pos.x, pos.z);
  if (bid >= 0) {
    let ubid = u32(bid);
    let b = buildings[ubid];
    if (b.height > 0.01 && b.destroyed < 0.5 && pos.y < b.height) {
      let dmg = params.u7.z * length(vel) * dt;
      // Reduce health (racy but acceptable; flag makes collapse single-shot)
      b.health = b.health - dmg;
      buildings[ubid] = b;

      if (b.health <= 0.0) {
        // Single shot collapse using atomic flag
        let r = atomicCompareExchangeWeak(&buildFlags[ubid], 0u, 1u);
        if (r.exchanged) {
          // Mark destroyed and collapse height
          b.height = 0.0;
          b.health = 0.0;
          b.destroyed = 1.0;
          buildings[ubid] = b;

          // Spawn debris fragments (both light and heavy)
          let maxD = u32(params.u7.w);
          for (var k: u32 = 0u; k < 16u; k = k + 1u) {
            let idx = atomicAdd(&debrisCount, 1u);
            if (idx >= maxD) { break; }

            let h0 = hash01(ubid * 131u + k * 17u);
            let h1 = hash01(ubid * 733u + k * 29u);
            let h2 = hash01(ubid * 997u + k * 53u);

            let ox = (h0 - 0.5) * 0.25;
            let oy = h1 * 0.25;
            let oz = (h2 - 0.5) * 0.25;

            let ty = select(0.0, 1.0, (k & 1u) == 1u); // 0 light, 1 heavy

            debris[idx].pos = vec4<f32>(pos.x + ox, max(pos.y, 0.05) + oy, pos.z + oz, ty);

            // Heavier chunks get more ballistic, light fragments get more floaty drift
            let kick = 1.6 + 1.8 * h2;
            let up = 1.2 + 1.4 * h1;
            let dir = normalize(vec3<f32>(h0 - 0.5, 0.3 + h1, h2 - 0.5));
            let v0 = dir * kick + vec3<f32>(0.4, up, 0.0);
            debris[idx].vel = vec4<f32>(v0, 1.0);
          }
        }
      }
    }
  }

  particles[i].pos = vec4<f32>(pos, 1.0);
  particles[i].vel = vec4<f32>(vel, 0.0);
}

@compute @workgroup_size(256)
fn updateDebris(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.x;
  let maxD = u32(params.u7.w);
  if (id >= maxD) { return; }

  var d = debris[id];
  if (d.vel.w < 0.5) { return; }

  let dt = params.u0.x;
  let gravityY = params.u1.x;

  var pos = d.pos.xyz;
  var vel = d.vel.xyz;
  let ty = d.pos.w; // 0 light, 1 heavy

  // Water proxy surface
  let ws = waterSurfaceAt(pos.x, pos.z);
  let inWater = pos.y < ws;

  // Buoyancy: light floats more, heavy less (can sink if fast/low buoyancy)
  if (inWater) {
    let buoy = mix(1.35, 0.55, ty);
    vel.y = vel.y + buoy * dt;
    // water drag
    vel = vel * (1.0 - 2.2 * dt);
    // push with wave drift
    vel.x = vel.x + 0.6 * dt;
  } else {
    vel.y = vel.y + gravityY * dt;
    // air drag
    vel = vel * (1.0 - 0.35 * dt);
  }

  // Integrate
  pos = pos + vel * dt;

  // Ground collision (same coast heightfield)
  let coastX = params.u5.x;
  let coastSlope = params.u5.y;
  let floorY = params.u1.w;
  let ground = floorY + max(0.0, pos.x - coastX) * coastSlope;
  if (pos.y < ground) {
    pos.y = ground;
    vel.y = -vel.y * 0.25;
    vel.xz = vel.xz * 0.6;
  }

  // Lifetime cull
  if (pos.y < -10.0 || abs(pos.x) > 30.0 || abs(pos.z) > 30.0) {
    d.vel.w = 0.0;
    debris[id] = d;
    return;
  }

  d.pos = vec4<f32>(pos, ty);
  d.vel = vec4<f32>(vel, 1.0);
  debris[id] = d;
}

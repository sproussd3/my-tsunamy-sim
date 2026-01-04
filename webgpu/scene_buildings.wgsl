struct Camera {
  view : mat4x4<f32>;
  proj : mat4x4<f32>;
  vp   : mat4x4<f32>;
  params0 : vec4<f32>;
  params1 : vec4<f32>;
};

struct BuildingCell {
  height : f32;
  health : f32;
  destroyed : f32;
  pad : f32;
};

@group(0) @binding(0) var<uniform> cam : Camera;
@group(0) @binding(1) var<storage, read> buildings : array<BuildingCell>;
@group(0) @binding(2) var<uniform> palette : array<vec4<f32>, 6>;
@group(0) @binding(3) var<uniform> bGrid : vec4<f32>; // dimX, dimZ, originX, originZ
@group(0) @binding(4) var<uniform> bStep : vec4<f32>; // cellSizeX, cellSizeZ, _, _

struct VSOut {
  @builtin(position) pos : vec4<f32>;
  @builtin(point_size) ps : f32;
  @location(0) h : f32;
  @location(1) dmg : f32;
};

@vertex
fn vsMain(@builtin(vertex_index) vid: u32) -> VSOut {
  var out : VSOut;
  let dimX = u32(bGrid.x);
  let dimZ = u32(bGrid.y);
  let id = vid;
  if (id >= dimX * dimZ) {
    out.pos = vec4<f32>(0.0);
    out.ps = 0.0;
    out.h = 0.0;
    out.dmg = 0.0;
    return out;
  }

  let b = buildings[id];
  let h = b.height;
  if (h <= 0.001) {
    out.pos = vec4<f32>(0.0);
    out.ps = 0.0;
    out.h = 0.0;
    out.dmg = 0.0;
    return out;
  }

  let ix = id % dimX;
  let iz = id / dimX;
  let x = bGrid.z + (f32(ix) + 0.5) * bStep.x;
  let z = bGrid.w + (f32(iz) + 0.5) * bStep.y;
  let y = 0.5 * h;

  let clip = cam.vp * vec4<f32>(x, y, z, 1.0);
  out.pos = clip;

  // Point sprite sized to read as a column
  let base = 14.0 + 110.0 * clamp(h, 0.0, 2.0);
  out.ps = base / max(0.25, clip.w);

  out.h = h;
  out.dmg = 1.0 - clamp(b.health, 0.0, 1.0);
  return out;
}

@fragment
fn fsMain(in: VSOut, @builtin(point_coord) pc: vec2<f32>) -> @location(0) vec4<f32> {
  // Make it more box-like (square)
  let d = max(abs(pc.x - 0.5), abs(pc.y - 0.5));
  let a = smoothstep(0.5, 0.44, d);

  let base = palette[4].xyz;
  let hot  = palette[0].xyz;
  let col = mix(base, hot, clamp(in.dmg, 0.0, 1.0));

  // simple top highlight
  let top = smoothstep(0.35, 0.0, abs(pc.y - 0.2));
  col = col + top * palette[1].xyz * 0.25;

  return vec4<f32>(col, a);
}

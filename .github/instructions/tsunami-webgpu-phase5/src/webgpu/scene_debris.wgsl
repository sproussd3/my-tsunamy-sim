struct Camera {
  view : mat4x4<f32>;
  proj : mat4x4<f32>;
  vp   : mat4x4<f32>;
  params0 : vec4<f32>;
  params1 : vec4<f32>;
};

struct Debris {
  pos : vec4<f32>; // xyz, type (0 light, 1 heavy)
  vel : vec4<f32>; // xyz, alive(0/1)
};

@group(0) @binding(0) var<uniform> cam : Camera;
@group(0) @binding(1) var<storage, read> debris : array<Debris>;
@group(0) @binding(2) var<uniform> palette : array<vec4<f32>, 6>;

struct VSOut {
  @builtin(position) pos : vec4<f32>;
  @builtin(point_size) ps : f32;
  @location(0) sp : f32;
  @location(1) ty : f32;
};

@vertex
fn vsMain(@builtin(vertex_index) id: u32) -> VSOut {
  var out: VSOut;
  let d = debris[id];
  if (d.vel.w < 0.5) {
    out.pos = vec4<f32>(0.0);
    out.ps = 0.0;
    out.sp = 0.0;
    out.ty = 0.0;
    return out;
  }
  let clip = cam.vp * vec4<f32>(d.pos.xyz, 1.0);
  out.pos = clip;
  let speed = length(d.vel.xyz);
  out.sp = speed;
  out.ty = d.pos.w;
  let base = mix(7.0, 12.0, out.ty);
  out.ps = base / max(0.25, clip.w);
  return out;
}

@fragment
fn fsMain(in: VSOut, @builtin(point_coord) pc: vec2<f32>) -> @location(0) vec4<f32> {
  let d = distance(pc, vec2<f32>(0.5));
  if (d > 0.5) { discard; }
  let a = smoothstep(0.5, 0.25, d);

  let bright = palette[1].xyz;
  let dark   = palette[4].xyz;
  let mid    = palette[3].xyz;

  let base = mix(mid, dark, in.ty);
  let col = mix(base, bright, clamp(in.sp * 0.12, 0.0, 1.0));
  return vec4<f32>(col, a);
}

struct Particle {
  pos : vec4<f32>;
  vel : vec4<f32>;
};

@group(0) @binding(0) var<uniform> vp : mat4x4<f32>;
@group(0) @binding(1) var<storage, read> particles : array<Particle>;
@group(0) @binding(2) var<uniform> palette : array<vec4<f32>, 6>;

struct VSOut {
  @builtin(position) position : vec4<f32>;
  @builtin(point_size) pointSize : f32;
  @location(0) speed : f32;
  @location(1) t : f32;
};

@vertex
fn vsMain(@builtin(vertex_index) vid : u32) -> VSOut {
  let p = particles[vid];
  let pos = p.pos.xyz;

  var out : VSOut;
  // NOTE: main.ts writes vp as view*proj (to match this multiply order).
  out.position = vec4<f32>(pos, 1.0) * vp;
  let v = p.vel.xyz;
  out.speed = length(v);
  out.t = clamp((pos.y + 0.2) * 0.7, 0.0, 1.0);

  // Make points smaller with distance
  let dist = max(0.5, out.position.w);
  out.pointSize = 6.0 / dist;
  return out;
}

@fragment
fn fsMain(
  in : VSOut,
  @builtin(point_coord) pc : vec2<f32>
) -> @location(0) vec4<f32> {
  let d = distance(pc, vec2<f32>(0.5, 0.5));
  if (d > 0.5) { discard; }

  // Soft edge
  let a = smoothstep(0.5, 0.35, d);

  // Palette-driven water color:
  // palette[0] "vibrant" as highlight, palette[3] "muted" as body, palette[4] "dark" as absorption.
  let body = palette[3].xyz;
  let hi = palette[0].xyz;
  let dark = palette[4].xyz;

  // Use particle height and speed to modulate tint and foam
  let foam = smoothstep(1.2, 2.8, in.speed);
  let tint = mix(dark, body, in.t);
  tint = mix(tint, hi, 0.25 * in.t);
  let col = mix(tint, vec3<f32>(1.0), foam * 0.55);

  return vec4<f32>(col, a);
}

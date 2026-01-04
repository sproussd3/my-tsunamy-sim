struct Particle {
  pos : vec4<f32>;
  vel : vec4<f32>;
};

struct Camera {
  view : mat4x4<f32>;
  proj : mat4x4<f32>;
  vp   : mat4x4<f32>;
  // params0: (tanHalfFov, aspect, near, far)
  params0 : vec4<f32>;
  // params1: (viewportH, radius, _, _)
  params1 : vec4<f32>;
};

@group(0) @binding(0) var<uniform> cam : Camera;
@group(0) @binding(1) var<storage, read> particles : array<Particle>;

struct VSOut {
  @builtin(position) position : vec4<f32>;
  @builtin(point_size) pointSize : f32;
  @location(0) centerView : vec3<f32>;
};

@vertex
fn vsMain(@builtin(vertex_index) vid : u32) -> VSOut {
  var out : VSOut;
  let p = particles[vid].pos.xyz;
  let cv4 = cam.view * vec4<f32>(p, 1.0);
  out.centerView = cv4.xyz;

  // Clip position of particle center
  out.position = cam.proj * cv4;

  // Projected point size: 2*radius in pixels.
  let tanHalfFov = cam.params0.x;
  let viewportH = cam.params1.x;
  let radius = cam.params1.y;

  // NDC radius in Y: r_ndc = radius / (-z * tanHalfFov)
  let rNdc = radius / max(1e-3, (-out.centerView.z) * tanHalfFov);
  out.pointSize = max(1.0, rNdc * (viewportH * 0.5) * 2.0);

  return out;
}

struct FSOut {
  @location(0) thickness : f32;
  @builtin(frag_depth) depth : f32;
};

@fragment
fn fsMain(in : VSOut, @builtin(point_coord) pc : vec2<f32>) -> FSOut {
  var out : FSOut;

  let radius = cam.params1.y;

  // point_coord in [0,1]. Map to [-1,1]
  let uv = (pc * 2.0) - vec2<f32>(1.0, 1.0);
  let dx = uv.x * radius;
  let dy = -uv.y * radius; // flip so +y is up in view space
  let rr = dx*dx + dy*dy;

  if (rr > radius*radius) {
    discard;
  }

  // Front-facing sphere intersection: move towards camera (+z in view space)
  let dz = sqrt(max(0.0, radius*radius - rr));
  let hit = in.centerView + vec3<f32>(dx, dy, dz);

  // Convert to clip depth
  let clip = cam.proj * vec4<f32>(hit, 1.0);
  let ndcZ = clip.z / clip.w; // WebGPU NDC z in [0,1] for our projection matrix

  out.depth = clamp(ndcZ, 0.0, 1.0);

  // Thickness proxy: more thickness near center of sphere
  out.thickness = dz / max(1e-3, radius);

  return out;
}

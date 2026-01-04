struct CameraParams {
  // params0: (tanHalfFov, aspect, near, far)
  params0 : vec4<f32>;
};

@group(0) @binding(0) var depthTex : texture_depth_2d;
@group(0) @binding(1) var thickTex : texture_2d<f32>;
@group(0) @binding(2) var smoothOut : texture_storage_2d<r16float, write>;
@group(0) @binding(3) var normalOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<uniform> cam : CameraParams;

fn linearizeDepth(ndcZ: f32, near: f32, far: f32) -> f32 {
  // WebGPU NDC z in [0,1]
  return (near * far) / max(1e-6, far - ndcZ * (far - near));
}

fn viewRay(uv01: vec2<f32>, tanHalfFov: f32, aspect: f32) -> vec3<f32> {
  // uv in [0,1] -> ndc [-1,1]
  let ndc = uv01 * 2.0 - vec2<f32>(1.0, 1.0);
  let x = ndc.x * aspect * tanHalfFov;
  let y = -ndc.y * tanHalfFov;
  return normalize(vec3<f32>(x, y, -1.0));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let dims = textureDimensions(thickTex);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let px = vec2<i32>(i32(gid.x), i32(gid.y));
  let uv = (vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5) / vec2<f32>(f32(dims.x), f32(dims.y)));

  let tanHalfFov = cam.params0.x;
  let aspect = cam.params0.y;
  let near = cam.params0.z;
  let far = cam.params0.w;

  let ndcZ0 = textureLoad(depthTex, px, 0);
  let t0 = textureLoad(thickTex, px, 0).x;

  // Empty pixel?
  if (ndcZ0 >= 0.9999 || t0 <= 0.0005) {
    textureStore(smoothOut, px, vec4<f32>(0.0, 0.0, 0.0, 0.0));
    textureStore(normalOut, px, vec4<f32>(0.0, 0.0, 0.0, 0.0));
    return;
  }

  let d0 = linearizeDepth(ndcZ0, near, far);

  // Bilateral blur (5x5)
  var sumW : f32 = 0.0;
  var sumD : f32 = 0.0;
  var sumT : f32 = 0.0;

  let sigmaS : f32 = 2.0;
  let sigmaD : f32 = 0.15; // depth sensitivity (in meters-ish if your scale is meters)

  for (var oy : i32 = -2; oy <= 2; oy = oy + 1) {
    for (var ox : i32 = -2; ox <= 2; ox = ox + 1) {
      let q = px + vec2<i32>(ox, oy);
      if (q.x < 0 || q.y < 0 || q.x >= i32(dims.x) || q.y >= i32(dims.y)) { continue; }

      let ndcZ = textureLoad(depthTex, q, 0);
      let tt = textureLoad(thickTex, q, 0).x;
      if (ndcZ >= 0.9999 || tt <= 0.0001) { continue; }

      let d = linearizeDepth(ndcZ, near, far);
      let ds = f32(ox*ox + oy*oy);
      let wS = exp(-ds / (2.0 * sigmaS * sigmaS));
      let dd = (d - d0);
      let wD = exp(-(dd*dd) / (2.0 * sigmaD * sigmaD));
      let w = wS * wD;

      sumW = sumW + w;
      sumD = sumD + w * d;
      sumT = sumT + w * tt;
    }
  }

  let dBlur = sumD / max(1e-6, sumW);
  let tBlur = sumT / max(1e-6, sumW);

  // Store smoothed linear depth
  textureStore(smoothOut, px, vec4<f32>(dBlur, 0.0, 0.0, 0.0));

  // Normal from depth derivatives in view space
  // Sample right and up (fallback to center if missing)
  let pxR = vec2<i32>(min(i32(dims.x) - 1, px.x + 1), px.y);
  let pxU = vec2<i32>(px.x, min(i32(dims.y) - 1, px.y + 1));

  let dR = textureLoad(smoothOut, pxR).x;
  let dU = textureLoad(smoothOut, pxU).x;

  if (dR <= 0.0) { dR = dBlur; }
  if (dU <= 0.0) { dU = dBlur; }

  let rayC = viewRay(uv, tanHalfFov, aspect);
  let rayR = viewRay((vec2<f32>(f32(pxR.x) + 0.5, f32(pxR.y) + 0.5) / vec2<f32>(f32(dims.x), f32(dims.y))), tanHalfFov, aspect);
  let rayU = viewRay((vec2<f32>(f32(pxU.x) + 0.5, f32(pxU.y) + 0.5) / vec2<f32>(f32(dims.x), f32(dims.y))), tanHalfFov, aspect);

  let PC = rayC * dBlur;
  let PR = rayR * dR;
  let PU = rayU * dU;

  let dX = PR - PC;
  let dY = PU - PC;

  var N = normalize(cross(dX, dY));
  // If something went weird, fall back to up-facing
  if (all(N == vec3<f32>(0.0))) {
    N = vec3<f32>(0.0, 1.0, 0.0);
  }

  let a = clamp(tBlur * 0.9, 0.0, 1.0);
  let enc = N * 0.5 + vec3<f32>(0.5);
  textureStore(normalOut, px, vec4<f32>(enc, a));
}

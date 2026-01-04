// Screen-space spray/mist synthesis
// Turns breaking-wave edges (from the reconstructed surface) into airborne mist.
// Cheap, stable, and designed to layer on top of the reconstructed water.

@group(0) @binding(0) var normalTex : texture_2d<f32>;       // rgb=normal(0..1), a=coverage
@group(0) @binding(1) var depthLinTex : texture_2d<f32>;     // linear depth (approx)
@group(0) @binding(2) var thicknessTex : texture_2d<f32>;    // accumulated thickness (r32float)
@group(0) @binding(3) var outMist : texture_storage_2d<r8unorm, write>;

fn saturate(x: f32) -> f32 {
  return clamp(x, 0.0, 1.0);
}

// Tiny hash noise (stable in screen space)
fn hash2(p: vec2<f32>) -> f32 {
  let h = dot(p, vec2<f32>(127.1, 311.7));
  let s = sin(h) * 43758.5453;
  return fract(s);
}

fn loadA(ix: i32, iy: i32) -> f32 {
  return textureLoad(normalTex, vec2<i32>(ix, iy), 0).w;
}

fn edgeAt(ix: i32, iy: i32, w: i32, h: i32) -> f32 {
  let a = loadA(ix, iy);
  let ix1 = min(ix + 1, w - 1);
  let iy1 = min(iy + 1, h - 1);
  let aR = loadA(ix1, iy);
  let aU = loadA(ix, iy1);
  return abs(aR - a) + abs(aU - a);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(outMist);
  let w = i32(dims.x);
  let h = i32(dims.y);
  let x = i32(gid.x);
  let y = i32(gid.y);

  if (x >= w || y >= h) { return; }

  let nEnc = textureLoad(normalTex, vec2<i32>(x, y), 0);
  let a = nEnc.w;

  // No water coverage -> no mist.
  if (a <= 0.01) {
    textureStore(outMist, vec2<i32>(x, y), vec4<f32>(0.0, 0.0, 0.0, 0.0));
    return;
  }

  let N = normalize(nEnc.xyz * 2.0 - vec3<f32>(1.0));
  let steep = saturate((1.0 - abs(N.y)) * 1.6); // breaking-wave proxy

  let thick = textureLoad(thicknessTex, vec2<i32>(x, y), 0).x;
  let depth = textureLoad(depthLinTex, vec2<i32>(x, y), 0).x;

  // Edge detection from coverage
  let edge = edgeAt(x, y, w, h);
  var mist = pow(saturate(edge * 4.0), 1.6) * saturate(thick * 0.25);
  mist *= (0.35 + 0.65 * steep);

  // Shallower areas get more visible spray
  mist *= saturate(1.0 - depth / 40.0);

  // Upward smear: pull edge energy from pixels below to simulate rising mist plume
  // (We sample BELOW the current pixel so the plume rises upward on screen.)
  for (var k: i32 = 1; k <= 4; k = k + 1) {
    let yy = min(y + k, h - 1);
    let e = edgeAt(x, yy, w, h);
    let t = textureLoad(thicknessTex, vec2<i32>(x, yy), 0).x;
    let add = pow(saturate(e * 4.0), 1.6) * saturate(t * 0.25);
    mist += add * (0.10 * f32(5 - k));
  }

  // Stable noise so it doesn't look like a perfect gradient
  let n = hash2(vec2<f32>(f32(x), f32(y)));
  mist *= (0.85 + 0.30 * n);

  mist = saturate(mist);

  textureStore(outMist, vec2<i32>(x, y), vec4<f32>(mist, 0.0, 0.0, 0.0));
}

struct CameraParams {
  // params0: (tanHalfFov, aspect, near, far)
  params0 : vec4<f32>;
};

@group(0) @binding(0) var normalTex : texture_2d<f32>;
@group(0) @binding(1) var depthLinTex : texture_2d<f32>;
@group(0) @binding(2) var mistTex : texture_2d<f32>;
@group(0) @binding(3) var<uniform> palette : array<vec4<f32>, 6>;
@group(0) @binding(4) var<uniform> cam : CameraParams;
@group(0) @binding(5) var samp : sampler;
@group(0) @binding(6) var sceneTex : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>;
  @location(0) uv : vec2<f32>;
};

@vertex
fn vsMain(@builtin(vertex_index) vid : u32) -> VSOut {
  // Fullscreen triangle
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0)
  );
  var out : VSOut;
  out.pos = vec4<f32>(p[vid], 0.0, 1.0);
  out.uv = (out.pos.xy * 0.5) + vec2<f32>(0.5);
  return out;
}

fn skyGradient(uv: vec2<f32>) -> vec3<f32> {
  // Palette slots: [0]=vibrant, [3]=muted, [4]=darkMuted, [5]=lightMuted
  let top = palette[5].xyz;
  let mid = palette[3].xyz;
  let bot = palette[4].xyz;
  let k = smoothstep(0.0, 1.0, uv.y);
  // Add a subtle horizon
  let h = smoothstep(0.35, 0.55, uv.y);
  return mix(bot, mix(mid, top, k), h);
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4<f32> {
  let sceneCol = textureSample(sceneTex, samp, in.uv).xyz;
  let tanHalfFov = cam.params0.x;
  let aspect = cam.params0.y;

  let sky = skyGradient(in.uv);

  let nEnc = textureSampleLevel(normalTex, samp, in.uv, 0.0);
  let a = nEnc.w;

  // If no water here, show the scene render (already cleared to a sky tone).
  if (a <= 0.01) {
    return vec4<f32>(sceneCol, 1.0);
  }

  let N = normalize(nEnc.xyz * 2.0 - vec3<f32>(1.0));

  // View ray for Fresnel
  let ndc = in.uv * 2.0 - vec2<f32>(1.0, 1.0);
  let viewDir = normalize(vec3<f32>(ndc.x * aspect * tanHalfFov, -ndc.y * tanHalfFov, -1.0));

  // Fresnel
  let NoV = clamp(dot(-viewDir, N), 0.0, 1.0);
  let fres = pow(1.0 - NoV, 5.0);

  // Base water color from palette
  let body = palette[3].xyz;
  let hi = palette[0].xyz;
  let dark = palette[4].xyz;

  // Depth-based absorption
  let depthLin = textureSampleLevel(depthLinTex, samp, in.uv, 0.0).x;
  let absorb = clamp(depthLin / 25.0, 0.0, 1.0);
  var water = mix(body, dark, absorb);
  water = mix(water, hi, 0.15);

  // Cheap refraction: bend sky by normal
  let refrUv = in.uv + N.xy * 0.02 * (1.0 - fres);
  let refr = skyGradient(clamp(refrUv, vec2<f32>(0.0), vec2<f32>(1.0)));

  let refl = sky; // reflection is sky here (later: real envmap)

  var col = mix(refr * water, refl, fres);

  // Foam: edges where alpha changes quickly
  let dims = textureDimensions(normalTex, 0);
  let du = vec2<f32>(1.0 / f32(dims.x), 1.0 / f32(dims.y));
  let aR = textureSampleLevel(normalTex, samp, in.uv + vec2<f32>(du.x, 0.0), 0.0).w;
  let aU = textureSampleLevel(normalTex, samp, in.uv + vec2<f32>(0.0, du.y), 0.0).w;
  let edge = abs(aR - a) + abs(aU - a);
  let foam = smoothstep(0.04, 0.18, edge) * 0.9;

  // Also foam on steep normals (breaking waves)
  let steep = smoothstep(0.55, 0.85, 1.0 - NoV);
  foam = clamp(foam + 0.35 * steep, 0.0, 1.0);

  col = mix(col, vec3<f32>(1.0), foam);

  // Mist/spray: additive light scattering on top of water
  let mist = textureSampleLevel(mistTex, samp, in.uv, 0.0).x;
  if (mist > 0.001) {
    let mistCol = mix(palette[5].xyz, vec3<f32>(1.0), 0.35);
    col = col + mist * mistCol * 0.65;
    // Slight haze toward sky to feel volumetric
    col = mix(col, sky, mist * 0.18);
  }

  // Composite water over the scene using alpha proxy
  let waterA = clamp(a * 1.2, 0.0, 1.0);
  col = mix(sceneCol, col, waterA);

  return vec4<f32>(col, 1.0);
}

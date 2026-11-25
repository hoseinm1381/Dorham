Texture2D<float4> image : register(t0);
SamplerState linearClamp : register(s0);
cbuffer SourceExtent : register(b0) { float2 used; float2 lastPixel; float2 outputSize; float2 padding; };

struct Vertex { float4 position : SV_Position; float2 uv : TEXCOORD0; };

Vertex fullscreen(uint id : SV_VertexID) {
    Vertex v;
    v.uv = float2((id << 1) & 2, id & 2);
    v.position = float4(v.uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return v;
}

float4 scaleFrame(Vertex v) : SV_Target {
    return float4(image.Sample(linearClamp, min(v.uv * used, lastPixel)).rgb, 1);
}

float3 rgbAt(float2 pixel) {
    return image.SampleLevel(linearClamp, min(pixel * used / outputSize, lastPixel), 0).rgb;
}

float luma(float3 rgb) { return (16.0 + dot(rgb, float3(46.5594, 156.6288, 15.8118))) / 255.0; }

// Each RGBA render-target texel stores four consecutive NV12 bytes.
float4 packNV12(Vertex v) : SV_Target {
    float2 pos = floor(v.position.xy);
    float x = pos.x * 4;
    if (pos.y < outputSize.y) {
        float2 p = float2(x + .5, pos.y + .5);
        return float4(luma(rgbAt(p)), luma(rgbAt(p + float2(1,0))),
                      luma(rgbAt(p + float2(2,0))), luma(rgbAt(p + float2(3,0))));
    }
    float2 p = float2(x + 1, (pos.y - outputSize.y) * 2 + 1);
    float3 a = rgbAt(p), b = rgbAt(p + float2(2,0));
    float3 cb = float3(-25.664, -86.336, 112), cr = float3(112, -101.73, -10.27);
    return (128 + float4(dot(a,cb), dot(a,cr), dot(b,cb), dot(b,cr))) / 255;
}

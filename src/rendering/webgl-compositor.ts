import type { ProjectState, TimelineLayer, VideoLayer, TextLayer, ShapeLayer, AETemplateLayer } from './project-types';
import { lerpKeyframe } from './interpolate';
import { rasterizeTemplateToCanvas } from './template-canvas';

type TextureSource = HTMLCanvasElement | HTMLVideoElement | HTMLImageElement;
type VideoResourceMap = Record<string, HTMLVideoElement> | Map<string, HTMLVideoElement>;

type TextureCacheEntry = {
  texture: WebGLTexture;
  width: number;
  height: number;
};

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'shader compile failed');
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext) {
  const vs = compile(gl, gl.VERTEX_SHADER, `#version 300 es
    precision highp float;
    in vec2 a_pos;
    in vec2 a_uv;
    uniform vec2 u_resolution;
    uniform vec2 u_translate;
    uniform vec2 u_size;
    uniform float u_rotation;
    uniform float u_scale;
    out vec2 v_uv;
    void main() {
      vec2 p = a_pos * u_size;
      float c = cos(u_rotation);
      float s = sin(u_rotation);
      mat2 rot = mat2(c, -s, s, c);
      p = rot * (p * u_scale);
      p += u_translate;
      vec2 zeroToOne = p / u_resolution;
      vec2 clip = zeroToOne * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
      v_uv = a_uv;
    }
  `);
  const fs = compile(gl, gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float;
    uniform sampler2D u_tex;
    uniform float u_opacity;
    in vec2 v_uv;
    out vec4 outColor;
    void main() {
      vec4 c = texture(u_tex, v_uv);
      outColor = vec4(c.rgb, c.a * u_opacity);
    }
  `);
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'program link failed');
  }
  return program;
}

export class WebGLCompositor {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  textureCache = new Map<string, TextureCacheEntry>();

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('webgl2 not available');
    this.gl = gl;
    this.program = createProgram(gl);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const verts = new Float32Array([
      -0.5, -0.5, 0, 1,
       0.5, -0.5, 1, 1,
      -0.5,  0.5, 0, 0,
      -0.5,  0.5, 0, 0,
       0.5, -0.5, 1, 1,
       0.5,  0.5, 1, 0,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(this.program, 'a_pos');
    const aUv = gl.getAttribLocation(this.program, 'a_uv');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
  }

  resize(width: number, height: number) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  private getTexture(key: string, source: TextureSource) {
    const gl = this.gl;
    let entry = this.textureCache.get(key);
    if (!entry) {
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      entry = { texture, width: 0, height: 0 };
      this.textureCache.set(key, entry);
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    entry.width = (source as any).videoWidth || (source as any).width;
    entry.height = (source as any).videoHeight || (source as any).height;
    return entry;
  }

  private drawTexture(texture: WebGLTexture, srcW: number, srcH: number, compW: number, compH: number, layer: TimelineLayer, localTime: number) {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_tex'), 0);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_resolution'), compW, compH);

    const x = lerpKeyframe(layer.kf?.x as any, localTime, layer.x);
    const y = lerpKeyframe(layer.kf?.y as any, localTime, layer.y);
    const scale = lerpKeyframe(layer.kf?.scale as any, localTime, layer.scale) / 100;
    const rotation = ((lerpKeyframe(layer.kf?.rotation as any, localTime, layer.rotation || 0) || 0) * Math.PI) / 180;
    const opacity = lerpKeyframe(layer.kf?.opacity as any, localTime, layer.opacity);

    gl.uniform1f(gl.getUniformLocation(this.program, 'u_opacity'), opacity);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_rotation'), rotation);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_scale'), scale);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_translate'), (x / 100) * compW, (y / 100) * compH);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_size'), srcW, srcH);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  private drawTextLayer(layer: TextLayer, comp: ProjectState['composition'], localTime: number) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(layer.width));
    canvas.height = Math.max(2, Math.round(layer.height));
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = layer.color || '#ffffff';
    ctx.font = `${layer.fontWeight || '700'} ${layer.fontSize}px ${layer.fontFamily || "Pretendard, 'Noto Sans KR', sans-serif"}`;
    ctx.textAlign = (layer.textAlign || 'center') as CanvasTextAlign;
    ctx.textBaseline = 'middle';
    const tx = layer.textAlign === 'left' ? 0 : layer.textAlign === 'right' ? canvas.width : canvas.width / 2;
    ctx.fillText(layer.content || '', tx, canvas.height / 2);
    const tex = this.getTexture(`text:${layer.id}:${layer.content}:${layer.fontSize}:${layer.color}`, canvas);
    this.drawTexture(tex.texture, canvas.width, canvas.height, comp.w, comp.h, layer, localTime);
  }

  private drawShapeLayer(layer: ShapeLayer, comp: ProjectState['composition'], localTime: number) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(layer.width));
    canvas.height = Math.max(2, Math.round(layer.height));
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = layer.color || '#ffffff';
    if (layer.type === 'circle') {
      ctx.beginPath();
      ctx.arc(canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const tex = this.getTexture(`shape:${layer.id}:${layer.color}:${layer.type}:${layer.width}:${layer.height}`, canvas);
    this.drawTexture(tex.texture, canvas.width, canvas.height, comp.w, comp.h, layer, localTime);
  }

  private drawTemplateLayer(layer: AETemplateLayer, comp: ProjectState['composition'], localTime: number) {
    const canvas = rasterizeTemplateToCanvas(layer, localTime, 1);
    const tex = this.getTexture(`template:${layer.id}:${localTime.toFixed(3)}`, canvas);
    this.drawTexture(tex.texture, canvas.width, canvas.height, comp.w, comp.h, layer, localTime);
  }

  render(project: ProjectState, time: number, resources: { videos?: VideoResourceMap; images?: Record<string, HTMLImageElement> } = {}) {
    const gl = this.gl;
    this.resize(project.composition.w, project.composition.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const ordered = [...project.layers]
      .filter(layer => layer.visible !== false && time >= layer.ts && time < layer.ts + layer.dur)
      .sort((a, b) => Number(a.layerOrder || 0) - Number(b.layerOrder || 0));

    for (const layer of ordered) {
      const localTime = time - layer.ts;
      if (layer.type === 'video') {
        const video = resources.videos instanceof Map ? resources.videos.get(layer.id) : resources.videos?.[layer.id];
        if (!video) continue;
        const tex = this.getTexture(`video:${layer.id}`, video);
        const w = (layer.sourceW || video.videoWidth || project.composition.w);
        const h = (layer.sourceH || video.videoHeight || project.composition.h);
        this.drawTexture(tex.texture, w, h, project.composition.w, project.composition.h, layer, localTime);
      // } else if (layer.type === 'text') {
      //   this.drawTextLayer(layer, project.composition, localTime);
      // } else if (layer.type === 'rectangle' || layer.type === 'circle') {
      //   this.drawShapeLayer(layer, project.composition, localTime);
      // } else if (layer.type === 'ae_template') {
      //   this.drawTemplateLayer(layer, project.composition, localTime);
      }
    }
  }
}

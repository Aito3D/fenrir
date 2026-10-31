var e={travel:0,wall:1,sparseInfill:2,solidInfill:3,skirt:4,support:5,raft:6,gapFill:7,thinWall:8,bridge:9,ironing:10,primeTower:11,outerWall:12,overhangWall:13,topSurface:14,bottomSurface:15},t={"outer wall":e.outerWall,"inner wall":e.wall,perimeter:e.wall,"external perimeter":e.outerWall,"overhang wall":e.overhangWall,"overhang perimeter":e.overhangWall,"sparse infill":e.sparseInfill,"internal infill":e.sparseInfill,"solid infill":e.solidInfill,"internal solid infill":e.solidInfill,"top surface":e.topSurface,"top solid infill":e.topSurface,"bottom surface":e.bottomSurface,skirt:e.skirt,"skirt/brim":e.skirt,brim:e.skirt,support:e.support,"support material":e.support,"support interface":e.support,"support material interface":e.support,"support transition":e.support,raft:e.raft,"gap fill":e.gapFill,"gap infill":e.gapFill,"thin wall":e.thinWall,"floating vertical shell":e.solidInfill,"internal bridge":e.bridge,"bottom shell":e.bottomSurface,bridge:e.bridge,"bridge infill":e.bridge,"internal bridge infill":e.bridge,ironing:e.ironing,"prime tower":e.primeTower,"wipe tower":e.primeTower,custom:e.wall},n=8,r=Math.PI*2,i=.02,a=256,o=15,s=class{data=new Float32Array(1024*n);count=0;widths=[];push(e,t,r,i,a,o,s,c,l){if((this.count+1)*n>this.data.length){let e=new Float32Array(this.data.length*2);e.set(this.data),this.data=e}let u=this.count*n;this.data[u]=e,this.data[u+1]=t,this.data[u+2]=r,this.data[u+3]=i,this.data[u+4]=a,this.data[u+5]=o,this.data[u+6]=s,this.data[u+7]=l,this.count+=1,this.widths.push(c)}get length(){return this.count}toFloat32Array(){return this.data.slice(0,this.count*n)}};function c(e){let t,n=0;for(let[r,i]of e)i>n&&(t=r,n=i);return t}function l(e,t){let n=e.indexOf(t);if(n<0)return;let r=Number.parseFloat(e.slice(n+1));return Number.isFinite(r)?r:void 0}function u(n,u){let d=[],f=0,p=0,m=0,h=0,g=!1,_=e.wall,v=0,y=new Map,b=0,x=0,S=new s,C=0,w=!1,T=null,E=!1,D=0,O=!1,k=null,A=1/0,j=1/0,M=1/0,N=-1/0,P=-1/0,F=-1/0,I=()=>{S.length!==0&&(d.push({z:C,paths:S.toFloat32Array(),widths:S.widths,remainingSec:k}),S=new s,E=!1,T!==null&&(C=T,T=null))},L=(t,n,r,i)=>{if(i){if(!w&&E&&r!==C&&I(),E||(C=r,T=null),E=!0,!O){O=!0,f=t,p=n,m=r;return}S.push(f,p,m,_,t,n,r,v,D),b+=1,t<A&&(A=t),n<j&&(j=n),r<M&&(M=r),t>N&&(N=t),n>P&&(P=n),r>F&&(F=r)}else O&&(S.push(f,p,m,e.travel,t,n,r,0,D),x+=1);f=t,p=n,m=r,O=!0},R=n.split(`
`),z=Math.max(2e3,Math.floor(R.length/50));for(let n=0;n<R.length;n+=1){u&&n%z===0&&n>0&&u(n/R.length);let s=R[n].trim();if(s.length===0)continue;if(s.charCodeAt(0)===59){let n=s.slice(1).trimStart(),r=n.indexOf(`:`),i=(r>=0?n.slice(0,r):n).trim().toUpperCase(),a=r>=0?n.slice(r+1).trim():``;if(i===`FEATURE`||i===`TYPE`)_=t[a.toLowerCase()]??e.wall;else if(i===`LINE_WIDTH`||i===`WIDTH`){let e=Number.parseFloat(a);Number.isFinite(e)&&e>0&&(v=e,y.set(e,(y.get(e)??0)+1))}else if(i===`CHANGE_LAYER`||i===`LAYER_CHANGE`)w=!0,I();else if(i===`Z_HEIGHT`||i===`Z`){let e=Number.parseFloat(a);Number.isFinite(e)&&(T=e)}continue}if(s.startsWith(`M73`)){let e=l(s,`R`);e!==void 0&&Number.isFinite(e)&&(k=Math.round(e*60));continue}if(s.startsWith(`M83`)){g=!0;continue}if(s.startsWith(`M82`)){g=!1;continue}if(s.startsWith(`G92`)){let e=l(s,`E`);e!==void 0&&(h=e);continue}if(s.charCodeAt(0)===84){let e=Number.parseInt(s.slice(1),10);Number.isFinite(e)&&e>=0&&e<=o&&(D=e);continue}let c=s.startsWith(`G2 `)||s.startsWith(`G3 `)||s.startsWith(`G2`)||s.startsWith(`G3`),d=s.startsWith(`G1`)||s.startsWith(`G0`);if(!d&&!c||c&&!/^G[23](\s|$)/.test(s)||d&&!/^G[01](\s|$)/.test(s))continue;let b=l(s,`X`)??f,x=l(s,`Y`)??p,S=l(s,`Z`)??m,C=l(s,`E`),E=0;C!==void 0&&(E=g?C:C-h,h=C);let O=E>0;if(c){let e=l(s,`I`)??0,t=l(s,`J`)??0,n=f+e,o=p+t,c=Math.hypot(e,t);if(c>0){let e=Math.atan2(p-o,f-n),t=Math.atan2(x-o,b-n),u=s.charCodeAt(1)===50,d=t-e;if(u){for(;d>=0;)d-=r;for(;d<-r;)d+=r}else{for(;d<=0;)d+=r;for(;d>r;)d-=r}if(b===f&&x===p){let e=Math.max(1,Math.round(l(s,`P`)??1));d=(u?-r:r)*e}let h=2*Math.acos(Math.max(-1,Math.min(1,1-i/c))),g=Math.max(1,Math.min(a,Math.ceil(Math.abs(d)/Math.max(h,.001))));for(let t=1;t<=g;t+=1){let r=t/g,i=e+d*r;L(n+c*Math.cos(i),o+c*Math.sin(i),m+(S-m)*r,O)}continue}}(b!==f||x!==p||S!==m)&&L(b,x,S,O)}return I(),{layers:d,segmentCount:b,travelCount:x,defaultWidth:c(y)??.42,bounds:b>0?{min:[A,j,M],max:[N,P,F]}:null}}function d(t){return t.map(t=>{let r=t.paths.slice();for(let t=0;t<r.length;t+=n)r[t+3]!==e.travel&&(r[t+3]=Math.min(r[t+7]+1,o));return{...t,paths:r}})}function f(e,t){if(t.size===0)return e;let r=[];for(let i of e){let e=new s;for(let r=0;r<i.paths.length;r+=n){let a=i.paths[r+3];t.has(a)||e.push(i.paths[r],i.paths[r+1],i.paths[r+2],a,i.paths[r+4],i.paths[r+5],i.paths[r+6],i.widths[r/n]??0,i.paths[r+7])}r.push({...i,paths:e.toFloat32Array(),widths:e.widths})}return r}var p=[0,1,2,0,2,3,0,3,4,0,4,5,0,5,6,0,6,1,5,4,7,5,7,6],m={0:[.42,.45,.5],1:[1,.9,.3],2:[.69,.19,.16],3:[.59,.33,.8],4:[0,.53,.43],5:[0,1,0],6:[0,.5,0],7:[1,1,1],8:[.9,.35,.65],9:[.3,.5,.73],10:[1,.55,.41],11:[.37,.82,.58],12:[1,.49,.22],13:[.12,.12,1],14:[.94,.25,.25],15:[.4,.36,.78]};function h(e){let t=Math.round(e[0]*255),n=Math.round(e[1]*255),r=Math.round(e[2]*255);return t<<16|n<<8|r}function g(e,t){let n=e.length,r=t>0?t:.42,i=Array(n);for(let t=0;t<n;t++){let n=e[t].z;i[t]=Math.max(.02,t===0?n:n-e[t-1].z)}let a=[],o=[],s=[],c=[],l=[],u=[],d=[],f=[],p=[],g=[],_=new Float64Array(16),v=[],y=[],b=-1,x=0,S=0,C=0,w=-1,T=0,E=1e-4,D=(e,t,n,r,i,p)=>(a.push(e),o.push(t),s.push(n),u.push(r),c.push(i),l.push(p),d.push(T),f.push(!1),a.length-1);for(let t=0;t<n;t++){let n=e[t].paths,a=e[t].widths,o=i[t];if(T=t,n)for(let e=0;e<n.length;e+=8){let i=n[e+3],s=n[e],c=n[e+1],l=n[e+2],u=n[e+4],d=n[e+5],m=n[e+6];if(i===0){v.push(s,c,l,u,d,m),y.push(t);continue}let h=a&&a[e/8]>0?a[e/8]:r;i<16&&(_[i]+=Math.hypot(u-s,d-c));let T;b>=0&&w===i&&Math.abs(x-s)<E&&Math.abs(S-c)<E&&Math.abs(C-l)<E?(T=b,D(u,d,m,i,o,h)):(T=D(s,c,l,i,o,h),D(u,d,m,i,o,h)),f[T]=!0,b=T+1,x=u,S=d,C=m,w=i,p.push(T),g.push(t)}}let O=a.length,k=p.length,A=new Float32Array(O*4),j=new Float32Array(O*4),M=0,N=!1,P=1/0,F=1/0,I=1/0,L=-1/0,R=-1/0,z=-1/0;for(let e=0;e<O;e++){let t=c[e],n=a[e],r=o[e],i=s[e]-.5*t;A[e*4]=n,A[e*4+1]=r,A[e*4+2]=i;let d=e>0&&f[e-1],p=f[e],g=0;if(d||p){let t=d?a[e]-a[e-1]:0,n=d?o[e]-o[e-1]:0,r=d?s[e]-s[e-1]:0,i=p?a[e+1]-a[e]:0,c=p?o[e+1]-o[e]:0,l=p?s[e+1]-s[e]:0;g=Math.atan2(t*c-n*i,t*i+n*c+r*l)}j[e*4]=t,j[e*4+1]=l[e],j[e*4+2]=g,j[e*4+3]=h(m[u[e]]||m[1]),(!Number.isFinite(n)||!Number.isFinite(r)||!Number.isFinite(i)||!Number.isFinite(g))&&(N=!0),M=Math.max(M,Math.abs(n),Math.abs(r),Math.abs(i)),n<P&&(P=n),n>L&&(L=n),r<F&&(F=r),r>R&&(R=r),i<I&&(I=i),i>z&&(z=i)}let B=new Uint32Array(k*4);for(let e=0;e<k;e++)B[e*4]=p[e],B[e*4+1]=g[e];let V={vType:new Uint8Array(O),vWidth:new Float32Array(O),vHeight:new Float32Array(O),vLayer:new Int32Array(O)};for(let e=0;e<O;e++)V.vType[e]=u[e],V.vWidth[e]=l[e],V.vHeight[e]=c[e],V.vLayer[e]=d[e];let H=new Int32Array(n+1);{let e=0;for(let t=0;t<n;t++){for(;e<k&&g[e]===t;)e++;H[t+1]=e}}let U=y.length,W=new Float32Array(U*6);for(let e=0;e<W.length;e++)W[e]=v[e];for(let e=0;e<W.length;e+=3){let t=W[e],n=W[e+1],r=W[e+2];t<P&&(P=t),t>L&&(L=t),n<F&&(F=n),n>R&&(R=n),r<I&&(I=r),r>z&&(z=r)}let G=new Int32Array(n+1);{let e=0;for(let t=0;t<n;t++){for(;e<U&&y[e]===t;)e++;G[t+1]=e}}let K=O+U>0?{min:[P,F,I],max:[L,R,z]}:null;return{position:A,hwa:j,segIndex:B,nV:O,nSeg:k,layerSegPrefix:H,travelPos:W,travelPrefix:G,nTrav:U,layerCount:n,maxAbs:M,hasNaN:N,meta:V,typeLengths:_,bbox:K}}var _=[[11,44,122],[19,89,133],[28,136,145],[4,214,15],[170,242,0],[252,249,3],[245,206,10],[227,136,32],[209,104,48],[194,82,60],[148,38,22]].map(e=>[e[0]/255,e[1]/255,e[2]/255]);function v(e,t,n,r){let i=r.length;if(!(n>t))return r[0];let a=(n-t)/(i-1),o=(e-t)/a,s=Math.max(0,Math.min(i-1,Math.floor(o))),c=Math.max(0,Math.min(i-1,s+1)),l=o-s,u=r[s],d=r[c];return[u[0]+(d[0]-u[0])*l,u[1]+(d[1]-u[1])*l,u[2]+(d[2]-u[2])*l]}var y=[{key:`feature`,label:`Feature type`,cont:!1,unit:``},{key:`speed`,label:`Speed`,cont:!0,unit:`mm/s`},{key:`height`,label:`Layer Height`,cont:!0,unit:`mm`},{key:`width`,label:`Line Width`,cont:!0,unit:`mm`},{key:`fan`,label:`Fan Speed`,cont:!0,unit:`%`},{key:`temp`,label:`Temperature`,cont:!0,unit:`°C`}];function b(e,t,n,r){let i=t.vType[n],a=t.vLayer[n],o=a===0;switch(e){case`height`:return t.vHeight[n];case`width`:return t.vWidth[n];case`speed`:return o?r.firstLayerSpeed:r.speedByType[i]??r.speedByType[1];case`fan`:return a<r.closeFanLayers?0:i===9?100:r.fanNormal;case`temp`:return o?r.tempFirst:r.tempNormal;default:return 0}}function x(e,t,n){let{meta:r,nV:i}=e,a=new Float32Array(i*4),o=y.find(e=>e.key===t)||y[0];if(!o.cont){for(let e=0;e<i;e++)a[e*4]=h(m[r.vType[e]]||m[1]);return{color:a,min:0,max:0,viewType:t,label:o.label,unit:o.unit,cont:!1}}let s=1/0,c=-1/0,l=new Float32Array(i);for(let e=0;e<i;e++){let i=b(t,r,e,n);l[e]=i,i<s&&(s=i),i>c&&(c=i)}Number.isFinite(s)||(s=0,c=1);for(let e=0;e<i;e++){let t=v(l[e],s,c,_);a[e*4]=h(t)}return{color:a,min:s,max:c,viewType:t,label:o.label,unit:o.unit,cont:!0}}var S=`
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
#define POINTY_CAPS
#define FIX_TWISTING
const vec3  light_top_dir = vec3(-0.4574957, 0.4574957, 0.7624929);
const float light_top_diffuse = 0.6 * 0.8;
const float light_top_specular = 0.6 * 0.125;
const float light_top_shininess = 20.0;
const vec3  light_front_dir = vec3(0.6985074, 0.1397015, 0.6985074);
const float light_front_diffuse = 0.6 * 0.3;
const float ambient = 0.3;
const float emission = 0.15;
const vec3 UP = vec3(0, 0, 1);
uniform mat4 view_matrix;
uniform mat4 projection_matrix;
uniform vec3 camera_position;
uniform sampler2D position_tex;
uniform sampler2D height_width_angle_tex;
uniform int layer_lo;   // 25단계: 이중 슬라이더 하한(레이어). 범위 밖 세그먼트는 셰이더가 O(1) 클립.
uniform int layer_hi;   //          상한은 instanceCount 로 컷(레이어 순 정렬).
in float vertex_id_float;
in uint seg_id_a_u;     // 인스턴스 어트리뷰트(구 segment_index_tex.r) — 어트리뷰트 fetch 가 texelFetch 보다 쌈
in uint seg_layer_u;    // 인스턴스 어트리뷰트(구 segment_index_tex.g)
out vec3 color;
vec3 decode_color(float col) {
  int c = int(round(col));
  int r = (c >> 16) & 0xFF;
  int g = (c >> 8) & 0xFF;
  int b = (c >> 0) & 0xFF;
  float f = 1.0 / 255.0;
  return f * vec3(r, g, b);
}
float lighting(vec3 eye_position, vec3 eye_normal) {
  float top_diffuse = light_top_diffuse * max(dot(eye_normal, light_top_dir), 0.0);
  float front_diffuse = light_front_diffuse * max(dot(eye_normal, light_front_dir), 0.0);
  float top_specular = light_top_specular * pow(max(dot(-normalize(eye_position), reflect(-light_top_dir, eye_normal)), 0.0), light_top_shininess);
  return ambient + top_diffuse + front_diffuse + top_specular + emission;
}
ivec2 tex_coord(sampler2D sampler, int id) {
  ivec2 tex_size = textureSize(sampler, 0);
  return (tex_size.y == 1) ? ivec2(id, 0) : ivec2(id % tex_size.x, id / tex_size.x);
}
void main() {
  int vertex_id = int(vertex_id_float);
  int seg_layer = int(seg_layer_u);
  if (seg_layer < layer_lo || seg_layer > layer_hi) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }   // 범위 밖 → 클립
  int id_a = int(seg_id_a_u);
  int id_b = id_a + 1;
  vec3 pos_a = texelFetch(position_tex, tex_coord(position_tex, id_a), 0).xyz;
  vec3 pos_b = texelFetch(position_tex, tex_coord(position_tex, id_b), 0).xyz;
  vec3 line = pos_b - pos_a;
  float line_len = length(line);
  vec3 line_dir;
  if (line_len < 1e-4)
    line_dir = vec3(1.0, 0.0, 0.0);
  else
    line_dir = line / line_len;
  vec3 line_right_dir;
  if (abs(dot(line_dir, UP)) > 0.9) {
    line_right_dir = normalize(cross(vec3(1, 0, 0), line_dir));
  }
  else
    line_right_dir = normalize(cross(line_dir, UP));
  vec3 line_up_dir = normalize(cross(line_right_dir, line_dir));
  const vec2 horizontal_vertical_view_signs_array[16] = vec2[](
    vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 0.0), vec2(0.0, -1.0),
    vec2(0.0, -1.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, 0.0),
    vec2(0.0, 1.0), vec2(-1.0, 0.0), vec2(0.0, 0.0), vec2(1.0, 0.0),
    vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(-1.0, 0.0), vec2(0.0, 0.0)
    );
  int id = vertex_id < 4 ? id_a : id_b;
  vec3 endpoint_pos = vertex_id < 4 ? pos_a : pos_b;
  vec4 hwa_color = texelFetch(height_width_angle_tex, tex_coord(height_width_angle_tex, id), 0);   // .xyz=h/w/angle, .w=packed color
  vec3 height_width_angle = hwa_color.xyz;
#ifdef FIX_TWISTING
  int closer_id = (dot(camera_position - pos_a, camera_position - pos_a) < dot(camera_position - pos_b, camera_position - pos_b)) ? id_a : id_b;
  vec3 closer_pos = (closer_id == id_a) ? pos_a : pos_b;
  vec3 camera_view_dir = normalize(closer_pos - camera_position);
  vec3 closer_height_width_angle = texelFetch(height_width_angle_tex, tex_coord(height_width_angle_tex, closer_id), 0).xyz;
  vec3 diagonal_dir_border = normalize(closer_height_width_angle.x * line_up_dir + closer_height_width_angle.y * line_right_dir);
#else
  vec3 camera_view_dir = normalize(endpoint_pos - camera_position);
  vec3 diagonal_dir_border = normalize(height_width_angle.x * line_up_dir + height_width_angle.y * line_right_dir);
#endif
  bool is_vertical_view = abs(dot(camera_view_dir, line_up_dir)) / abs(dot(diagonal_dir_border, line_up_dir)) >
    abs(dot(camera_view_dir, line_right_dir)) / abs(dot(diagonal_dir_border, line_right_dir));
  vec2 signs = horizontal_vertical_view_signs_array[vertex_id + 8 * int(is_vertical_view)];
#ifndef POINTY_CAPS
  if (vertex_id == 2 || vertex_id == 7) signs = -horizontal_vertical_view_signs_array[(vertex_id - 2) + 8 * int(is_vertical_view)];
#endif
  float view_right_sign = sign(dot(-camera_view_dir, line_right_dir));
  float view_top_sign = sign(dot(-camera_view_dir, line_up_dir));
  float half_height = 0.5 * height_width_angle.x;
  float half_width = 0.5 * height_width_angle.y;
  vec3 horizontal_dir = half_width * line_right_dir;
  vec3 vertical_dir = half_height * line_up_dir;
  float horizontal_sign = signs.x * view_right_sign;
  float vertical_sign = signs.y * view_top_sign;
  vec3 pos = endpoint_pos + horizontal_sign * horizontal_dir + vertical_sign * vertical_dir;
  if (vertex_id == 2 || vertex_id == 7) {
    float line_dir_sign = (vertex_id == 2) ? -1.0 : 1.0;
    if (height_width_angle.z == 0.0) {
#ifdef POINTY_CAPS
      pos += line_dir_sign * line_dir * half_width;
#endif
    }
    else {
      pos += line_dir_sign * line_dir * half_width * sin(abs(height_width_angle.z) * 0.5);
      pos += sign(height_width_angle.z) * horizontal_dir * cos(abs(height_width_angle.z) * 0.5);
    }
  }
  vec3 eye_position = (view_matrix * vec4(pos, 1.0)).xyz;
  vec3 eye_normal = (view_matrix * vec4(normalize(pos - endpoint_pos), 0.0)).xyz;
  vec3 color_base = decode_color(hwa_color.w);
  color = color_base * lighting(eye_position, eye_normal);
  gl_Position = projection_matrix * vec4(eye_position, 1.0);
}
`,C=`
precision highp float;
in vec3 color;
out vec4 fragment_color;
void main() {
  fragment_color = vec4(color, 1.0);
}
`;function w(e,t){let n=(t,n)=>{let r=Math.min(2048,Math.max(1,n)),i=Math.max(1,Math.ceil(n/r)),a=new Float32Array(r*i*4);a.set(t.subarray(0,Math.min(t.length,r*i*4)));let o=new e.DataTexture(a,r,i,e.RGBAFormat,e.FloatType);return o.minFilter=o.magFilter=e.NearestFilter,o.generateMipmaps=!1,o.needsUpdate=!0,o},r=n(t.position,t.nV),i=n(t.hwa,t.nV),a=new e.InstancedBufferGeometry;a.setIndex(p),a.setAttribute(`position`,new e.BufferAttribute(new Float32Array(24),3)),a.setAttribute(`vertex_id_float`,new e.BufferAttribute(new Float32Array([0,1,2,3,4,5,6,7]),1));let o=new e.InstancedInterleavedBuffer(t.segIndex,4);a.setAttribute(`seg_id_a_u`,new e.InterleavedBufferAttribute(o,1,0)),a.setAttribute(`seg_layer_u`,new e.InterleavedBufferAttribute(o,1,1)),a.instanceCount=0;let s=new e.RawShaderMaterial({glslVersion:e.GLSL3,uniforms:{view_matrix:{value:new e.Matrix4},projection_matrix:{value:new e.Matrix4},camera_position:{value:new e.Vector3},position_tex:{value:r},height_width_angle_tex:{value:i},layer_lo:{value:0},layer_hi:{value:t.layerCount}},vertexShader:S,fragmentShader:C,side:e.DoubleSide}),c=new e.Mesh(a,s),l=null;if(t.bbox){let{min:n,max:r}=t.bbox,i=new e.Vector3((n[0]+r[0])/2,(n[1]+r[1])/2,(n[2]+r[2])/2),a=Math.hypot(r[0]-n[0],r[1]-n[1],r[2]-n[2])/2+2;l=new e.Sphere(i,a)}c.frustumCulled=!!l,l&&(a.boundingSphere=l);let u=new e.Matrix4,d=new e.Vector3;c.onBeforeRender=(e,t,n)=>{s.uniforms.projection_matrix.value.copy(n.projectionMatrix),s.uniforms.view_matrix.value.multiplyMatrices(n.matrixWorldInverse,c.matrixWorld),u.copy(c.matrixWorld).invert(),n.getWorldPosition(d).applyMatrix4(u),s.uniforms.camera_position.value.copy(d)};let f=new e.BufferGeometry;f.setAttribute(`position`,new e.BufferAttribute(t.travelPos,3)),f.setDrawRange(0,0);let m=new e.LineSegments(f,new e.LineBasicMaterial({color:7041658}));m.frustumCulled=!!l,m.visible=!1,l&&(f.boundingSphere=l);let h=!1,g=0,_=t.layerCount-1,v=()=>{let e=t.travelPrefix[g],n=t.travelPrefix[_+1];f.setDrawRange(h?e*2:0,h?(n-e)*2:0)},y=(e,n)=>{let r=t.layerCount;g=Math.max(0,Math.min(r-1,e|0)),_=Math.max(g,Math.min(r-1,n|0)),s.uniforms.layer_lo.value=g,s.uniforms.layer_hi.value=_,a.instanceCount=t.layerSegPrefix[_+1],v()};return{mesh:c,travLines:m,setVisibleLayers:e=>y(0,(e|0)-1),setLayerRange:y,setTravelVisible:e=>{h=!!e,m.visible=h,v()},setColors:e=>{let t=i.image.data,n=Math.min(e.length,t.length)/4;for(let r=0;r<n;r++)t[r*4+3]=e[r*4];i.needsUpdate=!0},dispose:()=>{a.dispose(),s.dispose(),r.dispose(),i.dispose(),f.dispose(),m.material.dispose()},nSeg:t.nSeg,layerCount:t.layerCount}}export{g as a,d as c,w as i,u as l,_ as n,e as o,x as r,f as s,m as t};
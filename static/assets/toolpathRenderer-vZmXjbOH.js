var e={travel:0,wall:1,sparseInfill:2,solidInfill:3,skirt:4,support:5,raft:6,gapFill:7,thinWall:8,bridge:9,ironing:10,primeTower:11,outerWall:12,overhangWall:13,topSurface:14,bottomSurface:15},t={"outer wall":e.outerWall,"inner wall":e.wall,perimeter:e.wall,"external perimeter":e.outerWall,"overhang wall":e.overhangWall,"overhang perimeter":e.overhangWall,"sparse infill":e.sparseInfill,"internal infill":e.sparseInfill,"solid infill":e.solidInfill,"internal solid infill":e.solidInfill,"top surface":e.topSurface,"top solid infill":e.topSurface,"bottom surface":e.bottomSurface,skirt:e.skirt,"skirt/brim":e.skirt,brim:e.skirt,support:e.support,"support material":e.support,"support interface":e.support,"support material interface":e.support,"support transition":e.support,raft:e.raft,"gap fill":e.gapFill,"gap infill":e.gapFill,"thin wall":e.thinWall,"floating vertical shell":e.solidInfill,"internal bridge":e.bridge,"bottom shell":e.bottomSurface,bridge:e.bridge,"bridge infill":e.bridge,"internal bridge infill":e.bridge,ironing:e.ironing,"prime tower":e.primeTower,"wipe tower":e.primeTower,custom:e.wall},n=1.75,r=8,i=Math.PI*2,a=.02,o=256,s=15,c=class{data=new Float32Array(1024*r);count=0;widths=[];speeds=[];flows=[];push(e,t,n,i,a,o,s,c,l,u=0,d=0){if((this.count+1)*r>this.data.length){let e=new Float32Array(this.data.length*2);e.set(this.data),this.data=e}let f=this.count*r;this.data[f]=e,this.data[f+1]=t,this.data[f+2]=n,this.data[f+3]=i,this.data[f+4]=a,this.data[f+5]=o,this.data[f+6]=s,this.data[f+7]=l,this.count+=1,this.widths.push(c),this.speeds.push(u),this.flows.push(d)}get length(){return this.count}toFloat32Array(){return this.data.slice(0,this.count*r)}};function l(e){let t,n=0;for(let[r,i]of e)i>n&&(t=r,n=i);return t}function u(e,t){let n=e.indexOf(t);if(n<0)return;let r=Number.parseFloat(e.slice(n+1));return Number.isFinite(r)?r:void 0}function d(r,d){let f=[],p=0,m=0,h=0,g=0,_=!1,v=e.wall,y=0,b=new Map,x=0,S=Math.PI*(n/2)**2,C=0,w=0,T=new c,E=0,D=!1,O=null,k=!1,A=0,j=!1,M=null,N=1/0,P=1/0,F=1/0,I=-1/0,L=-1/0,R=-1/0,z=()=>{T.length!==0&&(f.push({z:E,paths:T.toFloat32Array(),widths:T.widths,remainingSec:M,speeds:T.speeds,flows:T.flows}),T=new c,k=!1,O!==null&&(E=O,O=null))},B=(t,n,r,i,a=0)=>{if(i){if(!D&&k&&r!==E&&z(),k||(E=r,O=null),k=!0,!j){j=!0,p=t,m=n,h=r;return}let e=x/60;T.push(p,m,h,v,t,n,r,y,A,e,a*S*e),C+=1,t<N&&(N=t),n<P&&(P=n),r<F&&(F=r),t>I&&(I=t),n>L&&(L=n),r>R&&(R=r)}else j&&(T.push(p,m,h,e.travel,t,n,r,0,A),w+=1);p=t,m=n,h=r,j=!0},V=r.split(`
`),H=Math.max(2e3,Math.floor(V.length/50));for(let n=0;n<V.length;n+=1){d&&n%H===0&&n>0&&d(n/V.length);let r=V[n].trim();if(r.length===0)continue;if(r.charCodeAt(0)===59){let n=r.slice(1).trimStart(),i=n.indexOf(`:`),a=(i>=0?n.slice(0,i):n).trim().toUpperCase(),o=i>=0?n.slice(i+1).trim():``;if(a===`FEATURE`||a===`TYPE`)v=t[o.toLowerCase()]??e.wall;else if(a.startsWith(`FILAMENT_DIAMETER`)){let e=Number.parseFloat(a.slice(a.indexOf(`=`)+1));Number.isFinite(e)&&e>0&&(S=Math.PI*(e/2)**2)}else if(a===`LINE_WIDTH`||a===`WIDTH`){let e=Number.parseFloat(o);Number.isFinite(e)&&e>0&&(y=e,b.set(e,(b.get(e)??0)+1))}else if(a===`CHANGE_LAYER`||a===`LAYER_CHANGE`)D=!0,z();else if(a===`Z_HEIGHT`||a===`Z`){let e=Number.parseFloat(o);Number.isFinite(e)&&(O=e)}continue}if(r.startsWith(`M73`)){let e=u(r,`R`);e!==void 0&&Number.isFinite(e)&&(M=Math.round(e*60));continue}if(r.startsWith(`M83`)){_=!0;continue}if(r.startsWith(`M82`)){_=!1;continue}if(r.startsWith(`G92`)){let e=u(r,`E`);e!==void 0&&(g=e);continue}if(r.charCodeAt(0)===84){let e=Number.parseInt(r.slice(1),10);Number.isFinite(e)&&e>=0&&e<=s&&(A=e);continue}let c=r.startsWith(`G2 `)||r.startsWith(`G3 `)||r.startsWith(`G2`)||r.startsWith(`G3`),l=r.startsWith(`G1`)||r.startsWith(`G0`);if(!l&&!c||c&&!/^G[23](\s|$)/.test(r)||l&&!/^G[01](\s|$)/.test(r))continue;let f=u(r,`X`)??p,C=u(r,`Y`)??m,w=u(r,`Z`)??h,T=u(r,`E`),E=u(r,`F`);E!==void 0&&E>0&&(x=E);let k=0;T!==void 0&&(k=_?T:T-g,g=T);let j=k>0;if(c){let e=u(r,`I`)??0,t=u(r,`J`)??0,n=p+e,s=m+t,c=Math.hypot(e,t);if(c>0){let e=Math.atan2(m-s,p-n),t=Math.atan2(C-s,f-n),l=r.charCodeAt(1)===50,d=t-e;if(l){for(;d>=0;)d-=i;for(;d<-i;)d+=i}else{for(;d<=0;)d+=i;for(;d>i;)d-=i}if(f===p&&C===m){let e=Math.max(1,Math.round(u(r,`P`)??1));d=(l?-i:i)*e}let g=2*Math.acos(Math.max(-1,Math.min(1,1-a/c))),_=Math.max(1,Math.min(o,Math.ceil(Math.abs(d)/Math.max(g,.001)))),v=Math.hypot(Math.abs(d)*c,w-h),y=j&&v>0?k/v:0;for(let t=1;t<=_;t+=1){let r=t/_,i=e+d*r;B(n+c*Math.cos(i),s+c*Math.sin(i),h+(w-h)*r,j,y)}continue}}if(f!==p||C!==m||w!==h){let e=Math.hypot(f-p,C-m,w-h);B(f,C,w,j,j&&e>0?k/e:0)}}return z(),{layers:f,segmentCount:C,travelCount:w,defaultWidth:l(b)??.42,bounds:C>0?{min:[N,P,F],max:[I,L,R]}:null}}function f(t){return t.map(t=>{let n=t.paths.slice();for(let t=0;t<n.length;t+=r)n[t+3]!==e.travel&&(n[t+3]=Math.min(n[t+7]+1,s));return{...t,paths:n}})}function p(e,t){if(t.size===0)return e;let n=[];for(let i of e){let e=new c;for(let n=0;n<i.paths.length;n+=r){let a=i.paths[n+3];t.has(a)||e.push(i.paths[n],i.paths[n+1],i.paths[n+2],a,i.paths[n+4],i.paths[n+5],i.paths[n+6],i.widths[n/r]??0,i.paths[n+7],i.speeds[n/r]??0,i.flows[n/r]??0)}n.push({...i,paths:e.toFloat32Array(),widths:e.widths,speeds:e.speeds,flows:e.flows})}return n}function m(t,n){let i=1/0,a=-1/0;for(let o of t){let t=n===`speed`?o.speeds:o.flows;for(let n=0;n<t.length;n+=1){if(o.paths[n*r+3]===e.travel)continue;let s=t[n];s<i&&(i=s),s>a&&(a=s)}}return i<=a?{min:i,max:a}:null}function h(e,t=11){return Array.from({length:t},(n,r)=>e.max-(e.max-e.min)*r/(t-1))}function g(t,n,i,a=11){let o=i.max-i.min;return t.map(t=>{let s=t.paths.slice(),c=n===`speed`?t.speeds:t.flows;for(let t=0;t<s.length;t+=r){if(s[t+3]===e.travel)continue;let n=o>0?(c[t/r]-i.min)/o:0;s[t+3]=1+Math.round(Math.min(1,Math.max(0,n))*(a-1))}return{...t,paths:s}})}var _=[0,1,2,0,2,3,0,3,4,0,4,5,0,5,6,0,6,1,5,4,7,5,7,6],v={0:[.42,.45,.5],1:[1,.9,.3],2:[.69,.19,.16],3:[.59,.33,.8],4:[0,.53,.43],5:[0,1,0],6:[0,.5,0],7:[1,1,1],8:[.9,.35,.65],9:[.3,.5,.73],10:[1,.55,.41],11:[.37,.82,.58],12:[1,.49,.22],13:[.12,.12,1],14:[.94,.25,.25],15:[.4,.36,.78]};function y(e){let t=Math.round(e[0]*255),n=Math.round(e[1]*255),r=Math.round(e[2]*255);return t<<16|n<<8|r}function b(e,t){let n=e.length,r=t>0?t:.42,i=Array(n);for(let t=0;t<n;t++){let n=e[t].z;i[t]=Math.max(.02,t===0?n:n-e[t-1].z)}let a=[],o=[],s=[],c=[],l=[],u=[],d=[],f=[],p=[],m=[],h=new Float64Array(16),g=[],_=[],b=-1,x=0,S=0,C=0,w=-1,T=0,E=1e-4,D=(e,t,n,r,i,p)=>(a.push(e),o.push(t),s.push(n),u.push(r),c.push(i),l.push(p),d.push(T),f.push(!1),a.length-1);for(let t=0;t<n;t++){let n=e[t].paths,a=e[t].widths,o=i[t];if(T=t,n)for(let e=0;e<n.length;e+=8){let i=n[e+3],s=n[e],c=n[e+1],l=n[e+2],u=n[e+4],d=n[e+5],v=n[e+6];if(i===0){g.push(s,c,l,u,d,v),_.push(t);continue}let y=a&&a[e/8]>0?a[e/8]:r;i<16&&(h[i]+=Math.hypot(u-s,d-c));let T;b>=0&&w===i&&Math.abs(x-s)<E&&Math.abs(S-c)<E&&Math.abs(C-l)<E?(T=b,D(u,d,v,i,o,y)):(T=D(s,c,l,i,o,y),D(u,d,v,i,o,y)),f[T]=!0,b=T+1,x=u,S=d,C=v,w=i,p.push(T),m.push(t)}}let O=a.length,k=p.length,A=new Float32Array(O*4),j=new Float32Array(O*4),M=0,N=!1,P=1/0,F=1/0,I=1/0,L=-1/0,R=-1/0,z=-1/0;for(let e=0;e<O;e++){let t=c[e],n=a[e],r=o[e],i=s[e]-.5*t;A[e*4]=n,A[e*4+1]=r,A[e*4+2]=i;let d=e>0&&f[e-1],p=f[e],m=0;if(d||p){let t=d?a[e]-a[e-1]:0,n=d?o[e]-o[e-1]:0,r=d?s[e]-s[e-1]:0,i=p?a[e+1]-a[e]:0,c=p?o[e+1]-o[e]:0,l=p?s[e+1]-s[e]:0;m=Math.atan2(t*c-n*i,t*i+n*c+r*l)}j[e*4]=t,j[e*4+1]=l[e],j[e*4+2]=m,j[e*4+3]=y(v[u[e]]||v[1]),(!Number.isFinite(n)||!Number.isFinite(r)||!Number.isFinite(i)||!Number.isFinite(m))&&(N=!0),M=Math.max(M,Math.abs(n),Math.abs(r),Math.abs(i)),n<P&&(P=n),n>L&&(L=n),r<F&&(F=r),r>R&&(R=r),i<I&&(I=i),i>z&&(z=i)}let B=new Uint32Array(k*4);for(let e=0;e<k;e++)B[e*4]=p[e],B[e*4+1]=m[e];let V={vType:new Uint8Array(O),vWidth:new Float32Array(O),vHeight:new Float32Array(O),vLayer:new Int32Array(O)};for(let e=0;e<O;e++)V.vType[e]=u[e],V.vWidth[e]=l[e],V.vHeight[e]=c[e],V.vLayer[e]=d[e];let H=new Int32Array(n+1);{let e=0;for(let t=0;t<n;t++){for(;e<k&&m[e]===t;)e++;H[t+1]=e}}let U=_.length,W=new Float32Array(U*6);for(let e=0;e<W.length;e++)W[e]=g[e];for(let e=0;e<W.length;e+=3){let t=W[e],n=W[e+1],r=W[e+2];t<P&&(P=t),t>L&&(L=t),n<F&&(F=n),n>R&&(R=n),r<I&&(I=r),r>z&&(z=r)}let G=new Int32Array(n+1);{let e=0;for(let t=0;t<n;t++){for(;e<U&&_[e]===t;)e++;G[t+1]=e}}let K=O+U>0?{min:[P,F,I],max:[L,R,z]}:null;return{position:A,hwa:j,segIndex:B,nV:O,nSeg:k,layerSegPrefix:H,travelPos:W,travelPrefix:G,nTrav:U,layerCount:n,maxAbs:M,hasNaN:N,meta:V,typeLengths:h,bbox:K}}var x=[[11,44,122],[19,89,133],[28,136,145],[4,214,15],[170,242,0],[252,249,3],[245,206,10],[227,136,32],[209,104,48],[194,82,60],[148,38,22]].map(e=>[e[0]/255,e[1]/255,e[2]/255]);function S(e,t,n,r){let i=r.length;if(!(n>t))return r[0];let a=(n-t)/(i-1),o=(e-t)/a,s=Math.max(0,Math.min(i-1,Math.floor(o))),c=Math.max(0,Math.min(i-1,s+1)),l=o-s,u=r[s],d=r[c];return[u[0]+(d[0]-u[0])*l,u[1]+(d[1]-u[1])*l,u[2]+(d[2]-u[2])*l]}var C=[{key:`feature`,label:`Feature type`,cont:!1,unit:``},{key:`speed`,label:`Speed`,cont:!0,unit:`mm/s`},{key:`height`,label:`Layer Height`,cont:!0,unit:`mm`},{key:`width`,label:`Line Width`,cont:!0,unit:`mm`},{key:`fan`,label:`Fan Speed`,cont:!0,unit:`%`},{key:`temp`,label:`Temperature`,cont:!0,unit:`°C`}];function w(e,t,n,r){let i=t.vType[n],a=t.vLayer[n],o=a===0;switch(e){case`height`:return t.vHeight[n];case`width`:return t.vWidth[n];case`speed`:return o?r.firstLayerSpeed:r.speedByType[i]??r.speedByType[1];case`fan`:return a<r.closeFanLayers?0:i===9?100:r.fanNormal;case`temp`:return o?r.tempFirst:r.tempNormal;default:return 0}}function T(e,t,n){let{meta:r,nV:i}=e,a=new Float32Array(i*4),o=C.find(e=>e.key===t)||C[0];if(!o.cont){for(let e=0;e<i;e++)a[e*4]=y(v[r.vType[e]]||v[1]);return{color:a,min:0,max:0,viewType:t,label:o.label,unit:o.unit,cont:!1}}let s=1/0,c=-1/0,l=new Float32Array(i);for(let e=0;e<i;e++){let i=w(t,r,e,n);l[e]=i,i<s&&(s=i),i>c&&(c=i)}Number.isFinite(s)||(s=0,c=1);for(let e=0;e<i;e++){let t=S(l[e],s,c,x);a[e*4]=y(t)}return{color:a,min:s,max:c,viewType:t,label:o.label,unit:o.unit,cont:!0}}var E=`
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
`,D=`
precision highp float;
in vec3 color;
out vec4 fragment_color;
void main() {
  fragment_color = vec4(color, 1.0);
}
`;function O(e,t){let n=(t,n)=>{let r=Math.min(2048,Math.max(1,n)),i=Math.max(1,Math.ceil(n/r)),a=new Float32Array(r*i*4);a.set(t.subarray(0,Math.min(t.length,r*i*4)));let o=new e.DataTexture(a,r,i,e.RGBAFormat,e.FloatType);return o.minFilter=o.magFilter=e.NearestFilter,o.generateMipmaps=!1,o.needsUpdate=!0,o},r=n(t.position,t.nV),i=n(t.hwa,t.nV),a=new e.InstancedBufferGeometry;a.setIndex(_),a.setAttribute(`position`,new e.BufferAttribute(new Float32Array(24),3)),a.setAttribute(`vertex_id_float`,new e.BufferAttribute(new Float32Array([0,1,2,3,4,5,6,7]),1));let o=new e.InstancedInterleavedBuffer(t.segIndex,4);a.setAttribute(`seg_id_a_u`,new e.InterleavedBufferAttribute(o,1,0)),a.setAttribute(`seg_layer_u`,new e.InterleavedBufferAttribute(o,1,1)),a.instanceCount=0;let s=new e.RawShaderMaterial({glslVersion:e.GLSL3,uniforms:{view_matrix:{value:new e.Matrix4},projection_matrix:{value:new e.Matrix4},camera_position:{value:new e.Vector3},position_tex:{value:r},height_width_angle_tex:{value:i},layer_lo:{value:0},layer_hi:{value:t.layerCount}},vertexShader:E,fragmentShader:D,side:e.DoubleSide}),c=new e.Mesh(a,s),l=null;if(t.bbox){let{min:n,max:r}=t.bbox,i=new e.Vector3((n[0]+r[0])/2,(n[1]+r[1])/2,(n[2]+r[2])/2),a=Math.hypot(r[0]-n[0],r[1]-n[1],r[2]-n[2])/2+2;l=new e.Sphere(i,a)}c.frustumCulled=!!l,l&&(a.boundingSphere=l);let u=new e.Matrix4,d=new e.Vector3;c.onBeforeRender=(e,t,n)=>{s.uniforms.projection_matrix.value.copy(n.projectionMatrix),s.uniforms.view_matrix.value.multiplyMatrices(n.matrixWorldInverse,c.matrixWorld),u.copy(c.matrixWorld).invert(),n.getWorldPosition(d).applyMatrix4(u),s.uniforms.camera_position.value.copy(d)};let f=new e.BufferGeometry;f.setAttribute(`position`,new e.BufferAttribute(t.travelPos,3)),f.setDrawRange(0,0);let p=new e.LineSegments(f,new e.LineBasicMaterial({color:7041658}));p.frustumCulled=!!l,p.visible=!1,l&&(f.boundingSphere=l);let m=!1,h=0,g=t.layerCount-1,v=()=>{let e=t.travelPrefix[h],n=t.travelPrefix[g+1];f.setDrawRange(m?e*2:0,m?(n-e)*2:0)},y=(e,n)=>{let r=t.layerCount;h=Math.max(0,Math.min(r-1,e|0)),g=Math.max(h,Math.min(r-1,n|0)),s.uniforms.layer_lo.value=h,s.uniforms.layer_hi.value=g,a.instanceCount=t.layerSegPrefix[g+1],v()};return{mesh:c,travLines:p,setVisibleLayers:e=>y(0,(e|0)-1),setLayerRange:y,setTravelVisible:e=>{m=!!e,p.visible=m,v()},setColors:e=>{let t=i.image.data,n=Math.min(e.length,t.length)/4;for(let r=0;r<n;r++)t[r*4+3]=e[r*4];i.needsUpdate=!0},dispose:()=>{a.dispose(),s.dispose(),r.dispose(),i.dispose(),f.dispose(),p.material.dispose()},nSeg:t.nSeg,layerCount:t.layerCount}}export{b as a,f as c,h as d,d as f,O as i,g as l,x as n,e as o,T as r,p as s,v as t,m as u};
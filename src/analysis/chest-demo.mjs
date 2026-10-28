import { createDemo } from './demo.mjs';
import { getExercise } from './exercises.mjs';

// Schematic geometry, never a real or professionally validated form template.
export function createChestDemo(exerciseId,options={}){
  const profile=getExercise(exerciseId),base=createDemo(options);
  const aspect=base.metadata.width/base.metadata.height;
  for(const sample of base.samples){
    const old=sample.landmarks;
    const a=old[11],b=old[13],c=old[15];
    const u=[(a.x-b.x)*aspect,a.y-b.y],v=[(c.x-b.x)*aspect,c.y-b.y];
    const angle=Math.acos(Math.max(-1,Math.min(1,(u[0]*v[0]+u[1]*v[1])/(Math.hypot(...u)*Math.hypot(...v)))));
    const phi=Math.PI-angle;
    const point=(x,y,visibility=.99)=>({x,y,z:0,visibility});
    const direction=profile.axis==='horizontal'?[1,0]:profile.variant==='pushup'?[0,1]:[0,-1];
    let shoulder=point(.37,.53),upper=.18,fore=.21;
    if(profile.variant==='incline'){shoulder=point(.36,.49);upper=.15;fore=.18;}
    if(profile.variant==='machine'){shoulder=point(.37,.33);upper=.18;fore=.2;}
    if(profile.variant==='pushup'){shoulder=point(.38,.34+(174-angle*180/Math.PI)/90*.13);upper=.16;fore=.18;}
    const [dx,dy]=direction;
    const elbow=point(shoulder.x+upper*(dx*Math.cos(phi)-dy*Math.sin(phi))/aspect,shoulder.y+upper*(dx*Math.sin(phi)+dy*Math.cos(phi)));
    const wrist=point(elbow.x+fore*dx/aspect,elbow.y+fore*dy);
    old[11]=shoulder;old[13]=elbow;old[15]=wrist;
    if(profile.variant==='incline'){old[23]=point(.61,.74);old[25]=point(.76,.79);old[27]=point(.72,.95);old[0]=point(.3,.46);}
    else if(profile.variant==='machine'){old[23]=point(.38,.73);old[25]=point(.62,.76);old[27]=point(.66,.94);old[0]=point(.36,.21);}
    else if(profile.variant==='pushup'){old[27]=point(.82,.71);old[23]=point((shoulder.x+old[27].x)/2,(shoulder.y+old[27].y)/2);old[25]=point(.72,.63);old[0]=point(.31,shoulder.y-.03);}
    else{old[23]=point(.66,.59);old[25]=point(.76,.77);old[27]=point(.71,.91);old[0]=point(.3,.51);}
    for(const [near,far]of[[11,12],[13,14],[15,16],[23,24],[25,26],[27,28]])old[far]=point(old[near].x+.02,old[near].y+.02,.35);
  }
  return{...base,metadata:{...base.metadata,name:`${profile.name} · 合成演示`,exerciseId:profile.id}};
}

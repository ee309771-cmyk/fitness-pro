// Six chest exercises explicitly selected by the user. Manual selection is
// required: this catalogue does not claim automatic exercise recognition.
export const EXERCISES = Object.freeze([
  { id:'incline_dumbbell_press', name:'上斜哑铃推胸', equipment:'哑铃 · 上斜凳', axis:'vertical', variant:'incline', bilateral:true,
    filming:'固定在上斜凳的正侧面，完整拍到近侧肩、肘、腕及哑铃移动范围。避开哑铃遮挡关节。',
    reference:'选择相同椅背角度、同类握法和同侧机位的上斜哑铃示范，不能用平板卧推代替。',
    limitation:'当前检查近侧手臂的动作周期，无法从侧拍证明两只哑铃同步或左右受力均衡。' },
  { id:'bench_press', name:'平板杠铃卧推', equipment:'杠铃 · 平板凳', axis:'vertical', variant:'flat', bilateral:false,
    filming:'镜头固定在平板凳的正侧面，肩、肘、腕完整入镜。避免杠铃片或保护者挡住近侧手臂。',
    reference:'使用同为平板杠铃卧推、握法接近、拍摄侧面一致的完整示范。',
    limitation:'肩胛状态、实际触胸、杠铃重量和关节受力无法仅凭肩肘腕关键点确定。' },
  { id:'incline_bench_press', name:'上斜杠铃卧推', equipment:'杠铃 · 上斜凳', axis:'vertical', variant:'incline', bilateral:false,
    filming:'镜头固定在上斜凳正侧面，保持水平。把近侧肩肘腕、杠铃移动范围和凳背轮廓留在画面内。',
    reference:'上斜角度和握法应与参考一致；不能混用平板杠铃或上斜哑铃示范。',
    limitation:'无法从侧拍确定握距是否适合个人，也不根据投影肘角推断触胸或肩部负荷。' },
  { id:'dumbbell_bench_press', name:'平板哑铃卧推', equipment:'哑铃 · 平板凳', axis:'vertical', variant:'flat', bilateral:true,
    filming:'固定在平板凳正侧面，让近侧肩肘腕和整只哑铃持续可见。不要在哑铃片正后方取景。',
    reference:'使用平板哑铃卧推的同侧完整动作，保持相同握法；不能用杠铃或上斜版本替代。',
    limitation:'近侧手臂计次不等于两臂同步计次；握法旋转和远侧手臂遮挡不作纠偏判断。' },
  { id:'machine_chest_press', name:'器械推胸', equipment:'坐姿推胸器械', axis:'horizontal', variant:'machine', bilateral:true,
    filming:'在器械正侧面固定镜头，让近侧肩、肘、腕和手柄移动范围完整可见；避免机架遮挡。',
    reference:'选择同类型器械和相同座椅设置的示范。不同器械的路径不可直接判作动作偏差。',
    limitation:'不同器械的轨迹由结构决定；当前只观察近侧肘部周期，不推断器械阻力或肩关节负荷。' },
  { id:'push_up', name:'俯卧撑', equipment:'自重 · 地面', axis:'vertical', variant:'pushup', bilateral:false,
    filming:'手机固定在身体正侧面较低位置，把肩、肘、腕、髋和踝都拍完整；画面保持水平。',
    reference:'使用同为标准俯卧撑的侧拍示范；跪姿、上斜支撑等变式请单独记录，不能直接混比。',
    limitation:'肩髋踝连线只是画面投影，不能据此诊断腰椎状态或实际核心发力。' },
]);

export function getExercise(id='bench_press') {
  const exercise=EXERCISES.find(e=>e.id===id);
  if(!exercise)throw new Error('当前仅支持已列出的六类胸部动作');
  return exercise;
}

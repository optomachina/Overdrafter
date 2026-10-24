using System; using System.Collections.Generic; using System.Runtime.InteropServices; using SolidWorks.Interop.sldworks; partial class TemporaryBoxes { static List<IFeature> Features(string phase){
  var list=new List<IFeature>();var seen=new HashSet<long>();var active=new HashSet<long>();var pins=new List<IntPtr>();
  Action<IFeature,bool> walk=null;walk=delegate(IFeature first,bool subchain){var chain=new HashSet<long>();IFeature f=first;while(f!=null){IntPtr pin=Marshal.GetIUnknownForObject(f);pins.Add(pin);long id=pin.ToInt64();Need(chain.Add(id) && !active.Contains(id),phase+"_no_true_cycle");
   if(seen.Add(id)){Need(list.Count<100,phase+"_feature_bound");list.Add(f);active.Add(id);IFeature sub=Own<IFeature>(phase+".GetFirstSubFeature",()=>f.GetFirstSubFeature());if(sub!=null)walk(sub,true);active.Remove(id);}
   IFeature prior=f;f=subchain?Own<IFeature>(phase+".GetNextSubFeature",()=>prior.GetNextSubFeature()):Own<IFeature>(phase+".GetNextFeature",()=>prior.GetNextFeature());
  }};
  try{walk(Own<IFeature>(phase+".FirstFeature",()=>Model.FirstFeature()),false);return list;}finally{foreach(IntPtr pin in pins)Marshal.Release(pin);}
 }
 static object[] Bodies(int kind,string phase){object raw=Call<object>(phase+".GetBodies2",()=>((IPartDoc)Model).GetBodies2(kind,false));if(raw==null)return new object[0];object[] a=raw as object[];Need(a!=null,phase+"_body_array");foreach(object b in a)if(b!=null)Owned.Add(b);return a;}

 static IFeature Bind(string phase){IFeature found=null;int matches=0;foreach(IFeature f in Features(phase))if(f.Name==BossName && f.GetTypeName2()==BossType){found=f;matches++;}Need(matches==1,phase+"_unique_boss");return found;}
 static T? Diagnostic<T>(string label,Func<T> action,List<string> errors) where T:struct {try{return Call<T>(label,action);}catch(Exception e){errors.Add(label+":0x"+e.HResult.ToString("X8"));return null;}}
 static void Verify(IFeature boss,double height,string phase){
  Guard();var record=new Dictionary<string,object>();Root[phase]=record;var errors=new List<string>();record["DiagnosticErrors"]=errors;record["Measurements"]="not_evaluated";
  IExtrudeFeatureData2 data=null;try{data=Own<IExtrudeFeatureData2>(phase+".GetDefinition",()=>boss.GetDefinition());}catch(Exception e){errors.Add("GetDefinition:0x"+e.HResult.ToString("X8"));}record["DefinitionCast"]=data!=null;
  bool? isBase=Diagnostic<bool>(phase+".IsBase2",()=>boss.IsBase2(),errors),isBoss=null,thin=null,both=null,reverse=null;double? depth=null;int? end=null,from=null;
  if(data!=null){isBoss=Diagnostic<bool>(phase+".IsBossFeature",()=>data.IsBossFeature(),errors);thin=Diagnostic<bool>(phase+".IsThinFeature",()=>data.IsThinFeature(),errors);both=Diagnostic<bool>(phase+".BothDirections",()=>data.BothDirections,errors);depth=Diagnostic<double>(phase+".GetDepth",()=>data.GetDepth(true),errors);end=Diagnostic<int>(phase+".GetEndCondition",()=>data.GetEndCondition(true),errors);from=Diagnostic<int>(phase+".FromType",()=>data.FromType,errors);reverse=Diagnostic<bool>(phase+".ReverseDirection",()=>data.ReverseDirection,errors);}
  record["IsBase"]=isBase;record["IsBossDiagnostic"]=isBoss;record["IsThin"]=thin;record["BothDirections"]=both;record["Depth"]=depth;record["EndCondition"]=end;record["FromType"]=from;record["ReverseDirection"]=reverse;
  Guard();Log("effect_intent",phase+".ForceRebuild3");bool? rebuild=Diagnostic<bool>(phase+".ForceRebuild3",()=>Model.ForceRebuild3(false),errors);Log("effect_result",phase+".ForceRebuild3");bool warning=false;int? nativeError=Diagnostic<int>(phase+".GetErrorCode2",()=>boss.GetErrorCode2(out warning),errors);record["RebuildReturned"]=rebuild;record["FeatureError"]=nativeError;record["IsWarning"]=nativeError.HasValue?(object)warning:null;
  Guard();object[] solid=null,sheet=null;try{solid=Bodies(0,phase+"_solid");}catch(Exception e){errors.Add("SolidBodies:0x"+e.HResult.ToString("X8"));}try{sheet=Bodies(1,phase+"_sheet");}catch(Exception e){errors.Add("SheetBodies:0x"+e.HResult.ToString("X8"));}record["SolidBodies"]=solid==null?null:(object)solid.Length;record["SheetBodies"]=sheet==null?null:(object)sheet.Length;
  Guard();double[] values=null;bool finite=false;if(solid!=null && solid.Length==1 && solid[0]!=null){try{values=Call<object>(phase+".GetMassProperties",()=>((IBody2)solid[0]).GetMassProperties(1.0)) as double[];finite=values!=null && values.Length>=12;if(values!=null)foreach(double v in values)finite &= !Double.IsNaN(v) && !Double.IsInfinity(v);}catch(Exception e){errors.Add("MassProperties:0x"+e.HResult.ToString("X8"));}record["Measurements"]="evaluated";}record["Finite"]=finite;if(values!=null)record["MassProperties"]=values;
  double volume=Math.PI*.010*.010*height,area=2*Math.PI*.010*(.010+height);record["Expected"]=new {Volume=volume,Area=area,Center=new double[]{0,0,height/2},TestDensity=1};
  bool geometry=finite && Math.Abs(values[3]-volume)<=1e-10 && Math.Abs(values[4]-area)<=1e-9 && Math.Abs(values[0])<=1e-8 && Math.Abs(values[1])<=1e-8 && Math.Abs(values[2]-height/2)<=1e-8;
  bool semantics=data!=null && isBase==true && thin==false && both==false && end==0 && from==0 && reverse==false && depth.HasValue && !Double.IsNaN(depth.Value) && !Double.IsInfinity(depth.Value) && Math.Abs(depth.Value-height)<=1e-10 && boss.Name==BossName && boss.GetTypeName2()==BossType;
  record["SemanticsPass"]=semantics;record["GeometryPass"]=geometry;record["NativePass"]=rebuild==true && nativeError==0;record["IsBossMandatory"]=false;
  Checks[phase+"_semantics"]=semantics?"pass":"fail";Checks[phase+"_geometry"]=geometry?"pass":finite?"fail":"not_evaluated";
  Need(errors.Count==0 && semantics && rebuild==true && nativeError==0 && solid!=null && solid.Length==1 && sheet!=null && sheet.Length==0 && geometry,phase);
 }
}

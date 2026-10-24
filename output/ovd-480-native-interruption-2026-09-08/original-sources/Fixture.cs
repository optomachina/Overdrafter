using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Web.Script.Serialization;
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;
partial class TemporaryBoxes {
 static Dictionary<string,object> Root=new Dictionary<string,object>();
 static Dictionary<string,object> Checks=new Dictionary<string,object>();
 static List<object> Owned=new List<object>();static List<string> ReleaseErrors=new List<string>();
 static ISldWorks Sw;static IModelDoc2 Model;static string CurrentPath,Package,Recovery,Baseline,Candidate,BaselineHash,CandidateHash,BossType;
 const string RecoveryHash="6e7b80222f6c8f3f632f1a7c49d3482b705cf0f6b99a4f7d73ab32eb66731e7d",BossName="OVD_QualificationExtrusion";
 static void Log(string phase,string stage){Console.Error.WriteLine(new JavaScriptSerializer().Serialize(new {UTC=DateTime.UtcNow.ToString("o"),Phase=phase,Stage=stage,Partial=Root}));Console.Error.Flush();}
 static T Call<T>(string stage,Func<T> f){Root["Stage"]=stage;Log("before",stage);try{T v=f();Log("after",stage);return v;}catch(Exception e){if(!Root.ContainsKey("FirstFailureStage")){Root["FirstFailureStage"]=stage;Root["FirstFailureHRESULT"]="0x"+e.HResult.ToString("X8");}Log("exception",stage);throw;}}
 static void Need(bool good,string stage){Checks[stage]=good?"pass":"fail";Log("predicate",stage);if(!good){if(!Root.ContainsKey("FirstFailureStage"))Root["FirstFailureStage"]=stage;throw new InvalidOperationException(stage);}}
 static T Own<T>(string stage,Func<object> f) where T:class {object o=Call<object>(stage,f);if(o!=null)Owned.Add(o);return (T)o;}
 static void ReleaseOwned(){Model=null;for(int i=Owned.Count-1;i>=0;i--)try{if(Marshal.IsComObject(Owned[i]))Marshal.ReleaseComObject(Owned[i]);}catch(Exception e){ReleaseErrors.Add("0x"+e.HResult.ToString("X8"));}Owned.Clear();Log("cleanup","release_document_references");}
 static string Hash(string path){using(var f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(f)).Replace("-","").ToLowerInvariant();}
 static void Guard(){Need(Sw.GetDocumentCount()==1 && Model!=null && Model.GetPathName().Equals(CurrentPath,StringComparison.OrdinalIgnoreCase),"sole_owned_document");}
 static T Effect<T>(string stage,Func<T> f){Guard();Log("effect_intent",stage);T r=Call<T>(stage,f);Log("effect_result",stage);return r;}
 static bool Same(object x,object y){if(x==null || y==null)return false;IntPtr a=Marshal.GetIUnknownForObject(x),b=Marshal.GetIUnknownForObject(y);try{return a==b;}finally{Marshal.Release(a);Marshal.Release(b);}}
 [STAThread] static int Main(string[] args){
  AppDomain.CurrentDomain.AssemblyResolve+=delegate(object s,ResolveEventArgs e){string n=new AssemblyName(e.Name).Name;return n=="SolidWorks.Interop.sldworks" || n=="SolidWorks.Interop.swconst"?Assembly.LoadFrom(@"C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\api\redist\"+n+".dll"):null;};
  Root["ObservedUTC"]=DateTime.UtcNow.ToString("o");Root["HelperPID"]=Process.GetCurrentProcess().Id;Root["Apartment"]=Thread.CurrentThread.GetApartmentState().ToString();Root["Status"]="not_started";Root["Checks"]=Checks;Root["Qualification"]="one_part_only_incomplete";
  foreach(string key in new[]{"blank_acceptance","plane_acceptance","construction","baseline_5mm","save_5mm","candidate_copy","candidate_before_edit","dimension_edit","candidate_8mm","save_8mm","reopen_8mm","final_hashes","final_empty"})Checks[key]="not_evaluated";
  try{int pid;if(args.Length!=3 || !Int32.TryParse(args[0],out pid) || !Int64.TryParse(args[1],out ExpectedTicks) || !Int32.TryParse(args[2],out ExpectedSession))throw new ArgumentException();Need(Thread.CurrentThread.GetApartmentState()==ApartmentState.STA,"STA");GuardPredicateTests(pid);NativeIdentity(pid,Root,"PrebindIdentity");Run(pid);}
  catch(Exception e){Root["Status"]="nativefixture_failed";Root["TerminalExceptionType"]=e.GetType().FullName;Root["TerminalHRESULT"]="0x"+e.HResult.ToString("X8");}
  Root["ReleaseErrors"]=ReleaseErrors;if(ReleaseErrors.Count>0)Root["Status"]="cleanup_failure";
  Console.WriteLine(new JavaScriptSerializer().Serialize(Root));return (string)Root["Status"]=="nativefixture_pass" && ReleaseErrors.Count==0?0:2;
 }
 static void Open(string path,bool readOnly,string phase){
  Need(Sw.GetDocumentCount()==0,phase+"_empty_before_open");int errors=0,warnings=0;int options=(int)swOpenDocOptions_e.swOpenDocOptions_Silent|(readOnly?(int)swOpenDocOptions_e.swOpenDocOptions_ReadOnly:0);
  CurrentPath=path;Model=Own<IModelDoc2>(phase+".OpenDoc6",()=>Sw.OpenDoc6(path,1,options,"",ref errors,ref warnings));Root[phase+"Open"]=new {Errors=errors,Warnings=warnings,ReadOnly=readOnly};Need(Model!=null && errors==0,phase+"_open");Guard();Need(Model.GetConfigurationCount()==1,phase+"_one_configuration");object sketch=Own<object>(phase+".GetActiveSketch",()=>Model.GetActiveSketch());Need(sketch==null,phase+"_no_active_sketch");if(readOnly)Need(Model.IsOpenedReadOnly(),phase+"_readonly");
 }
 static List<IFeature> Features(string phase){
  var list=new List<IFeature>();var seen=new HashSet<long>();var active=new HashSet<long>();var pins=new List<IntPtr>();
  Action<IFeature,bool> walk=null;walk=delegate(IFeature first,bool subchain){var chain=new HashSet<long>();IFeature f=first;while(f!=null){IntPtr pin=Marshal.GetIUnknownForObject(f);pins.Add(pin);long id=pin.ToInt64();Need(chain.Add(id) && !active.Contains(id),phase+"_no_true_cycle");
   if(seen.Add(id)){Need(list.Count<100,phase+"_feature_bound");list.Add(f);active.Add(id);IFeature sub=Own<IFeature>(phase+".GetFirstSubFeature",()=>f.GetFirstSubFeature());if(sub!=null)walk(sub,true);active.Remove(id);}
   IFeature prior=f;f=subchain?Own<IFeature>(phase+".GetNextSubFeature",()=>prior.GetNextSubFeature()):Own<IFeature>(phase+".GetNextFeature",()=>prior.GetNextFeature());
  }};
  try{walk(Own<IFeature>(phase+".FirstFeature",()=>Model.FirstFeature()),false);return list;}finally{foreach(IntPtr pin in pins)Marshal.Release(pin);}
 }
 static object[] Bodies(int kind,string phase){object raw=Call<object>(phase+".GetBodies2",()=>((IPartDoc)Model).GetBodies2(kind,false));if(raw==null)return new object[0];object[] a=raw as object[];Need(a!=null,phase+"_body_array");foreach(object b in a)if(b!=null)Owned.Add(b);return a;}
 static IFeature BlankAndPlane(){
  object[] solid=Bodies(0,"blank_solid"),sheet=Bodies(1,"blank_sheet");IModelDocExtension extension=Own<IModelDocExtension>("blank.Extension",()=>Model.Extension);IEquationMgr eq=Own<IEquationMgr>("blank.EquationMgr",()=>Model.GetEquationMgr());
  int refs=Call<int>("blank.ExternalReferencesCount",()=>extension.ListExternalFileReferencesCount()),aux=Call<int>("blank.AuxiliaryReferencesCount",()=>Model.ListAuxiliaryExternalFileReferencesCount()),equations=Call<int>("blank.EquationCount",()=>eq.GetCount());
  var types=new List<string>();var planes=new List<IFeature>();var allowed=new HashSet<string>{"HistoryFolder","CommentsFolder","FavoriteFolder","SelectionSetFolder","SensorFolder","DetailCabinet","SolidBodyFolder","SurfaceBodyFolder","MaterialFolder","EqnFolder","RefPlane","OriginProfileFeature"};
  Need(Hash(Recovery)==RecoveryHash && Hash(Baseline)==RecoveryHash && Model.GetConfigurationCount()==1,"fixture_specific_admission_scope");
  string[] approved={"DocsFolder","NotesAreaFtrFolder","EnvFolder","AmbientLight","DirectionLight","InkMarkupFolder"};foreach(string type in approved)allowed.Add(type);
  Root["FixtureSpecificTypePolicy"]=new {AdditionalTypes=approved,InputHash=RecoveryHash,Scope="this exact recovered copy and single configuration only",Evidence="AmbientLight/DirectionLight documented ILight; DocsFolder documented folder; EnvFolder/NotesAreaFtrFolder/InkMarkupFolder observed/inferred containers, not certified exact vendor mappings"};
  bool accepted=solid.Length==0 && sheet.Length==0 && refs==0 && aux==0 && equations==0;
  foreach(IFeature f in Features("blank")){string type=Call<string>("blank.FeatureType",()=>f.GetTypeName2());types.Add(type);accepted &= allowed.Contains(type);if(type=="RefPlane")planes.Add(f);}
  Root["Blank"]=new {SolidBodies=solid.Length,SheetBodies=sheet.Length,ExternalReferences=refs,AuxiliaryReferences=aux,Equations=equations,FeatureTypes=types,Provenance="recovered user-authorized local part copy; not factory template"};Need(accepted,"blank_acceptance");
  IMathUtility math=Own<IMathUtility>("GetMathUtility",()=>Sw.GetMathUtility());IFeature selected=null;var observations=new List<object>();Root["PlaneObservations"]=observations;
  for(int i=0;i<planes.Count;i++){IFeature f=planes[i];IRefPlane p=Own<IRefPlane>("plane.GetSpecificFeature2",()=>f.GetSpecificFeature2());IMathTransform transform=Own<IMathTransform>("plane.Transform",()=>p.Transform);IMathPoint origin=Own<IMathPoint>("plane.CreatePoint",()=>math.CreatePoint(new double[]{0,0,0}));IMathVector normal=Own<IMathVector>("plane.CreateVector",()=>math.CreateVector(new double[]{0,0,1}));IMathPoint worldOrigin=Own<IMathPoint>("plane.TransformPoint",()=>origin.MultiplyTransform(transform));IMathVector worldNormal=Own<IMathVector>("plane.TransformVector",()=>normal.MultiplyTransform(transform));double[] o=(double[])worldOrigin.ArrayData,n=(double[])worldNormal.ArrayData;bool match=o.Length==3 && n.Length==3 && Math.Abs(o[0])<=1e-9 && Math.Abs(o[1])<=1e-9 && Math.Abs(o[2])<=1e-9 && Math.Abs(n[0])<=1e-9 && Math.Abs(n[1])<=1e-9 && Math.Abs(n[2]-1)<=1e-9;observations.Add(new {Index=i,Name=f.Name,Origin=o,Normal=n,Transform=(double[])transform.ArrayData,Match=match});if(selected==null && match)selected=f;}
  Need(selected!=null,"plane_acceptance");return selected;
 }
 static IFeature Construct(IFeature plane){
  Effect<bool>("ClearSelections",()=>{Model.ClearSelection2(true);return true;});Need(Effect<bool>("SelectActualPlane",()=>plane.Select2(false,0)),"plane_selected");ISketchManager mgr=Own<ISketchManager>("SketchManager",()=>Model.SketchManager);
  Effect<bool>("InsertSketch_enter",()=>{mgr.InsertSketch(true);return true;});ISketch sketch=Own<ISketch>("ActiveSketch",()=>mgr.ActiveSketch);Need(sketch!=null,"active_sketch");object circle=Own<object>("CreateCircleByRadius",()=>Effect<object>("circle_effect",()=>mgr.CreateCircleByRadius(0,0,0,.010)));Need(circle!=null,"circle_created");
  IFeature sketchFeature=null;int matches=0;foreach(IFeature f in Features("new_sketch"))if(f.GetTypeName2()=="ProfileFeature"){object specific=Own<object>("sketch.GetSpecificFeature2",()=>f.GetSpecificFeature2());if(Same(specific,sketch)){sketchFeature=f;matches++;}}
  Need(matches==1,"actual_sketch_binding");Root["SketchBinding"]=new {Name=sketchFeature.Name,Type=sketchFeature.GetTypeName2(),ConstraintStatus="not fully constrained; radius supplied at creation"};Effect<bool>("InsertSketch_exit",()=>{mgr.InsertSketch(true);return true;});Need(mgr.ActiveSketch==null,"sketch_exited");Effect<bool>("ClearBeforeBoss",()=>{Model.ClearSelection2(true);return true;});Need(Effect<bool>("SelectActualSketch",()=>sketchFeature.Select2(false,0)),"sketch_selected");
  IFeatureManager fm=Own<IFeatureManager>("FeatureManager",()=>Model.FeatureManager);IFeature boss=Own<IFeature>("FeatureExtrusion3",()=>Effect<object>("extrusion_effect",()=>fm.FeatureExtrusion3(true,false,false,(int)swEndConditions_e.swEndCondBlind,(int)swEndConditions_e.swEndCondBlind,.005,0,false,false,false,false,0,0,false,false,false,false,true,false,true,(int)swStartConditions_e.swStartSketchPlane,0,false)));Need(boss!=null,"boss_created");Effect<bool>("NameOwnedExtrusion",()=>{boss.Name=BossName;return true;});BossType=boss.GetTypeName2();Root["BossBinding"]=new {Name=boss.Name,Type=BossType};Need(boss.Name==BossName,"construction");return boss;
 }
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
 static void Save(string phase){int errors=0,warnings=0;bool success=Effect<bool>(phase+".Save3",()=>Model.Save3((int)swSaveAsOptions_e.swSaveAsOptions_Silent,ref errors,ref warnings));Root[phase+"Receipt"]=new {Returned=success,Errors=errors,Warnings=warnings};Need(success && errors==0 && warnings==0 && !Model.GetSaveFlag() && Model.GetPathName().Equals(CurrentPath,StringComparison.OrdinalIgnoreCase),phase);}
 static void Close(string phase){Guard();string title=Model.GetTitle();ReleaseOwned();Need(ReleaseErrors.Count==0,phase+"_references");Need(Sw.GetDocumentCount()==1,phase+"_sole_before_close");Call<bool>(phase+".CloseOwnedDoc",()=>{Sw.CloseDoc(title);return true;});Need(Sw.GetDocumentCount()==0,phase+"_empty");CurrentPath=null;}
 static void Edit(IFeature boss){IExtrudeFeatureData2 data=Own<IExtrudeFeatureData2>("edit.GetDefinition",()=>boss.GetDefinition());bool access=false,modified=false;try{access=Effect<bool>("edit.AccessSelections",()=>data.AccessSelections(Model,null));Need(access,"edit_selection_access");Effect<bool>("edit.SetDepth",()=>{data.SetDepth(true,.008);return true;});modified=Effect<bool>("edit.ModifyDefinition",()=>boss.ModifyDefinition(data,Model,null));Need(modified,"dimension_edit");}finally{if(access && !modified)Call<bool>("edit.AbortReleaseSelectionAccess",()=>{data.ReleaseSelectionAccess();return true;});}}
 [MethodImpl(MethodImplOptions.NoInlining)] static void Run(int expected){
  Need(typeof(ISldWorks).Assembly.GetName().Version.ToString()=="30.5.0.49" && typeof(ISldWorks).GUID==new Guid("83A33D22-27C5-11CE-BFD4-00400513BB57"),"interop_identity");Need((int)swEndConditions_e.swEndCondBlind==0 && (int)swStartConditions_e.swStartSketchPlane==0,"installed_enums");
  var settings=new JavaScriptSerializer().Deserialize<Dictionary<string,string>>(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"settings.json")));Package=settings["Package"];Recovery=settings["Recovery"];Baseline=Path.Combine(Package,"baseline-5mm.SLDPRT");Candidate=Path.Combine(Package,"candidate-8mm.SLDPRT");Root["Files"]=new {Recovery=Recovery,Baseline=Baseline,Candidate=Candidate};Need(new FileInfo(Recovery).Length==25332 && Hash(Recovery)==RecoveryHash,"recovery_hash");Need(!Directory.Exists(Package),"fresh_package");
  object app=null;try{
   app=Call<object>("GetActiveObject",()=>Marshal.GetActiveObject("SldWorks.Application.30"));Sw=(ISldWorks)app;Need(Sw.GetProcessID()==expected && Sw.RevisionNumber()=="30.5.0","api_identity");Root["DocumentCountBefore"]=Sw.GetDocumentCount();Need(Sw.GetDocumentCount()==0,"initial_empty");
   Directory.CreateDirectory(Package);File.Copy(Recovery,Baseline,false);Need(Hash(Baseline)==RecoveryHash,"recovery_copy");Open(Baseline,false,"baseline");IFeature plane=BlankAndPlane();IFeature boss=Construct(plane);Verify(boss,.005,"baseline_5mm");Save("save_5mm");Close("close_baseline");BaselineHash=Hash(Baseline);Root["BaselineSHA256"]=BaselineHash;
   File.Copy(Baseline,Candidate,false);Need(Hash(Candidate)==BaselineHash,"candidate_copy");Open(Candidate,false,"candidate");boss=Bind("candidate_bind");Verify(boss,.005,"candidate_before_edit");Edit(boss);Verify(boss,.008,"candidate_8mm");Save("save_8mm");Close("close_candidate");CandidateHash=Hash(Candidate);Root["CandidateSHA256"]=CandidateHash;
   Open(Candidate,true,"reopen");boss=Bind("reopen_bind");Verify(boss,.008,"reopen_8mm");Close("close_reopen");Need(Hash(Baseline)==BaselineHash && Hash(Candidate)==CandidateHash && Hash(Recovery)==RecoveryHash,"final_hashes");Need(Sw.GetDocumentCount()==0,"final_empty");Root["Status"]="nativefixture_pass";
  }finally{ReleaseOwned();if(Sw!=null)try{if((string)Root["Status"]!="nativefixture_pass")FailureCloseOwnedCopy();Root["DocumentCountAfter"]=Call<int>("final.GetDocumentCount",()=>Sw.GetDocumentCount());NativeIdentity(expected,Root,"AfterIdentity");}catch(Exception e){Root["CleanupCheckHRESULT"]="0x"+e.HResult.ToString("X8");Root["Status"]="cleanup_failure";}Sw=null;if(app!=null)try{Marshal.ReleaseComObject(app);}catch(Exception e){ReleaseErrors.Add("application:0x"+e.HResult.ToString("X8"));}}
 }
}





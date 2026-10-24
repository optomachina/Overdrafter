using System;
using System.IO;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;
partial class TemporaryBoxes {
 static void ClosePriorOwnedCopy(){
  Need(Sw.GetDocumentCount()==1,"prior_sole_document");
  string prior=Path.Combine(Path.GetDirectoryName(Package),"native-dimension-01-61d292c4db7148e199dd9c078ba2ebeb","baseline-5mm.SLDPRT");
  object raw=Call<object>("prior.GetFirstDocument",()=>Sw.GetFirstDocument());
  try{IModelDoc2 doc=(IModelDoc2)raw;Need(doc!=null && doc.GetType()==1 && doc.GetPathName().Equals(prior,StringComparison.OrdinalIgnoreCase) && !doc.GetSaveFlag(),"prior_exact_clean_owned_copy");Need(Hash(prior)==RecoveryHash,"prior_disk_unchanged");string title=doc.GetTitle();Need(Sw.GetDocumentCount()==1,"prior_sole_before_close");Call<bool>("prior.CloseOwnedCopy",()=>{Sw.CloseDoc(title);return true;});Need(Sw.GetDocumentCount()==0,"prior_closed_empty");Root["PriorOwnedCopyClosed"]=true;}
  finally{if(raw!=null)Marshal.ReleaseComObject(raw);}
 }
 static void FailureCloseOwnedCopy(){
  int count=Sw.GetDocumentCount();Root["FailureCleanupCountBefore"]=count;if(count==0){Root["FailureCleanup"]="already_empty";return;}if(count!=1){Root["FailureCleanup"]="skipped_other_documents";return;}
  object raw=Sw.GetFirstDocument();try{IModelDoc2 doc=raw as IModelDoc2;if(doc==null){Root["FailureCleanup"]="unknown_document";return;}string path=doc.GetPathName();bool ours=path.Equals(Baseline,StringComparison.OrdinalIgnoreCase)||path.Equals(Candidate,StringComparison.OrdinalIgnoreCase);if(!ours){Root["FailureCleanup"]="skipped_unknown_path";return;}
   Root["FailureCleanupPath"]=path;Root["FailureCleanupDirty"]=doc.GetSaveFlag();string title=doc.GetTitle();Log("failure_recorded_before_discard","owned_failure_cleanup");if(Sw.GetDocumentCount()!=1){Root["FailureCleanup"]="skipped_count_drift";return;}
   Sw.CloseDoc(title);int after=Sw.GetDocumentCount();Root["FailureCleanupCountAfter"]=after;Root["FailureCleanup"]=after==0?"closed_owned_without_save":"close_incomplete";
  }finally{if(raw!=null)Marshal.ReleaseComObject(raw);}
 }
}

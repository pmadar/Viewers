handleMeasurementAdded = function(e, eventData) {
    var measurementData = eventData.measurementData;

    switch (eventData.toolType) {
        case 'nonTarget':
        case 'lesion':
            log.info('CornerstoneToolsMeasurementAdded');
            OHIF.viewer.manuallyModifyingMeasurement = true;
            LesionManager.updateLesionData(measurementData);
            TrialResponseCriteria.validateDelayed(measurementData);
            break;
    }
};
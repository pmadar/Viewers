import { Meteor } from 'meteor/meteor';
import { Template } from 'meteor/templating';
import { Tracker } from 'meteor/tracker';
import { Session } from 'meteor/session';
import { Random } from 'meteor/random';
import { $ } from 'meteor/jquery';
// OHIF Modules
import { OHIF } from 'meteor/ohif:core';
// Local Modules
import { StackManager } from '../../../lib/StackManager';
import { setActiveViewport } from '../../../lib/setActiveViewport';
import { imageViewerViewportData } from '../../../lib/imageViewerViewportData';
import { updateCrosshairsSynchronizer } from '../../../lib/updateCrosshairsSynchronizer';
import { toolManager } from '../../../lib/toolManager';
import { updateOrientationMarkers } from '../../../lib/updateOrientationMarkers';
import { getInstanceClassDefaultViewport } from '../../../lib/instanceClassSpecificViewport';
import { PlayClipManager } from '../../../lib/classes/PlayClipManager';
import { OHIFError } from '../../../lib/classes/OHIFError';

const allCornerstoneEvents = 'CornerstoneToolsMouseDown CornerstoneToolsMouseDownActivate ' +
    'CornerstoneToolsMouseClick CornerstoneToolsMouseDrag CornerstoneToolsMouseUp ' +
    'CornerstoneToolsMouseWheel CornerstoneToolsTap CornerstoneToolsTouchPress ' +
    'CornerstoneToolsTouchStart CornerstoneToolsTouchStartActive ' +
    'CornerstoneToolsMultiTouchDragStart';

/**
 * This function loads a study series into a viewport element.
 *
 * @param data {object} Object containing the study, series, and viewport element to be used
 */
const loadDisplaySetIntoViewport = (data, templateData) => {
    OHIF.log.info('imageViewerViewport loadDisplaySetIntoViewport');

    // Make sure we have all the data required to render the series
    if (!data.study || !data.displaySet || !data.element) {
        OHIF.log.warn('loadDisplaySetIntoViewport: No Study, Display Set, or Element provided');
        return;
    }

    // Get the current element and it's index in the list of all viewports
    // The viewport index is often used to store information about a viewport element
    const element = data.element;
    const viewportIndex = $('.imageViewerViewport').index(element);

    const layoutManager = OHIF.viewerbase.layoutManager;
    layoutManager.viewportData = layoutManager.viewportData || {};
    layoutManager.viewportData[viewportIndex] = layoutManager.viewportData[viewportIndex] || {};
    layoutManager.viewportData[viewportIndex].viewportIndex = viewportIndex;

    // Stop here if no data was defined for the viewer
    if (!OHIF.viewer.data) return;

    // This data will be saved so that the viewport can be reloaded to the same state  later
    OHIF.viewer.data.loadedSeriesData[viewportIndex] = {};

    // Create shortcut to displaySet
    const displaySet = data.displaySet;

    // Get stack from Stack Manager
    let stack = StackManager.findOrCreateStack(data.study, displaySet);

    // If is a clip, updates the global FPS for cine dialog
    if (stack.isClip && stack.frameRate > 0) {
        // Sets the global variable
        OHIF.viewer.cine.framesPerSecond = parseFloat(stack.frameRate);
        // Update the cine dialog FPS
        Session.set('UpdateCINE', Random.id());
    }

    // Shortcut for array with image IDs
    const imageIds = stack.imageIds;

    // Define the current image stack using the newly created image IDs
    stack = {
        currentImageIdIndex: data.currentImageIdIndex > 0 && data.currentImageIdIndex < imageIds.length ? data.currentImageIdIndex : 0,
        imageIds: imageIds,
        displaySetInstanceUid: data.displaySetInstanceUid
    };

    // Get the current image ID for the stack that will be rendered
    const imageId = imageIds[stack.currentImageIdIndex];

    // Save the current image ID inside the template data so it can be
    // retrieved from the template helpers
    templateData.imageId = imageId;

    // Save the current image ID inside the ViewportLoading object.
    //
    // The ViewportLoading object relates the viewport elements with whichever
    // image is currently being loaded into them. This is useful so that we can
    // place progress (download %) for each image inside the proper viewports.
    window.ViewportLoading[viewportIndex] = imageId;

    // Enable Cornerstone for the viewport element
    const options = {
        renderer: 'webgl'
    };

    // NOTE: This uses the experimental WebGL renderer for Cornerstone!
    // If you have problems, replace it with this line instead:
    // cornerstone.enable(element);
    cornerstone.enable(element, options);

    // Get the handler functions that will run when loading has finished or thrown
    // an error. These are used to show/hide loading / error text boxes on each viewport.
    const endLoadingHandler = cornerstoneTools.loadHandlerManager.getEndLoadHandler();
    const errorLoadingHandler = cornerstoneTools.loadHandlerManager.getErrorLoadingHandler();

    // Get the current viewport settings
    const viewport = cornerstone.getViewport(element);

    const { studyInstanceUid, seriesInstanceUid, displaySetInstanceUid, currentImageIdIndex } = data;

    // Store the current series data inside the Layout Manager
    layoutManager.viewportData[viewportIndex] = {
        imageId,
        studyInstanceUid,
        seriesInstanceUid,
        displaySetInstanceUid,
        currentImageIdIndex,
        viewport: viewport || data.viewport,
        viewportIndex
    };

    // Handle the case where the imageId isn't loaded correctly and the
    // imagePromise returns undefined
    // To test, uncomment the next line
    // data.imageId = 'AfileThatDoesntWork'; // For testing only!

    let imagePromise;
    try {
        imagePromise = cornerstone.loadAndCacheImage(imageId);
    } catch (error) {
        OHIF.log.info(error);
        if (!imagePromise) {
            errorLoadingHandler(element, imageId, error);
            return;
        }
    }

    // Additional tasks for metadata provider. If using your own
    // metadata provider, this may not be necessary.
    // updateMetadata is important, though, to update image metadata that
    // for any reason was missing some information such as rows, columns,
    // sliceThickness, etc (See MetadataProvider class from ohif-cornerstone package)
    const metadataProvider = OHIF.viewer.metadataProvider;
    const isUpdateMetadataDefined = metadataProvider && typeof metadataProvider.updateMetadata === 'function';

    // loadAndCacheImage configurable callbacks
    const callbacks = imageViewerViewportData.callbacks;

    // Check if it has before loadAndCacheImage callback
    if (typeof callbacks.before === 'function') {
        OHIF.log.info('imageViewerViewport before loadAndCacheImage callback');
        callbacks.before(imagePromise, templateData);
    }

    // Start loading the image.
    imagePromise.then(image => {
        let enabledElement;
        try {
            enabledElement = cornerstone.getEnabledElement(element);
        }
        catch (error) {
            OHIF.log.warn('Viewport destroyed before loaded image could be displayed');
            return;
        }

        // Caches element's jQuery object
        const $element = $(element);

        // Update the enabled element with the image and viewport data
        // This is not usually necessary, but we need them stored in case
        // a sopClassUid-specific viewport setting is present.
        enabledElement.image = image;
        enabledElement.viewport = cornerstone.getDefaultViewport(enabledElement.canvas, image);

        if (isUpdateMetadataDefined) {
            // Update the metaData for missing fields
            metadataProvider.updateMetadata(image);
        }

        // Check if there are default viewport settings for this sopClassUid
        if (!displaySet.images || !displaySet.images.length) {
            return;
        }

        const instance = displaySet.images[0];
        const instanceClassViewport = getInstanceClassDefaultViewport(instance, enabledElement, image.imageId);

        // If there are sopClassUid-specific viewport settings, apply them
        if (instanceClassViewport) {
            cornerstone.displayImage(element, image, instanceClassViewport);

            // Mark that this element should not be fit to the window in the resize listeners
            // TODO: Find another way to do this?
            enabledElement.fitToWindow = false;

            // Resize the canvas to fit the current viewport element size.
            cornerstone.resize(element, false);
        } else if (data.viewport) {
            // If there is a saved object containing Cornerstone viewport data
            // (e.g. scale, invert, window settings) in the input data, apply it now.
            cornerstone.displayImage(element, image, data.viewport);

            // Resize the canvas to fit the current viewport element size. Fit the displayed
            // image to the canvas dimensions.
            cornerstone.resize(element, true);
        } else {
            // If no saved viewport settings or modality-specific settings exists,
            // display the loaded image in the viewport element with no loaded viewport
            // settings.
            cornerstone.displayImage(element, image);

            // Resize the canvas to fit the current viewport element size. Fit the displayed
            // image to the canvas dimensions.
            cornerstone.resize(element, true);
        }

        // Remove the data for this viewport from the ViewportLoading object
        // This will stop the loading percentage complete from being displayed.
        delete window.ViewportLoading[viewportIndex];

        // Call the handler function that represents the end of the image loading phase
        // (e.g. hide the progress text box)
        endLoadingHandler(element, image);

        // Remove the 'empty' class from the viewport to hide any instruction text
        element.classList.remove('empty');

        // Hide the viewport instructions (i.e. 'Drag a stack here') and show
        // the viewport overlay data.
        $element.siblings('.viewportInstructions').hide();
        $element.siblings('.imageViewerViewportOverlay').show();

        // Add stack state managers for the stack tool, CINE tool, and reference lines
        cornerstoneTools.addStackStateManager(element, ['stack', 'playClip', 'referenceLines']);

        // Enable orientation markers, if applicable
        updateOrientationMarkers(element);

        // Clear any old stack data
        cornerstoneTools.clearToolState(element, 'stack');
        cornerstoneTools.addToolState(element, 'stack', stack);

        // Set the default CINE settings
        const multiframeMetadata = instance.getDataProperty('multiframeMetadata');

        let fps;
        if (multiframeMetadata && multiframeMetadata.averageFrameRate > 0) {
            fps = multiframeMetadata.averageFrameRate;
        } else {
            fps = OHIF.viewer.cine.framesPerSecond;
        }

        const cineToolData = {
            loop: OHIF.viewer.cine.loop,
            framesPerSecond: fps
        };

        cornerstoneTools.addToolState(element, 'playClip', cineToolData);

        const playClipManager = PlayClipManager.getInstance();
        const playClipController = playClipManager.add(element, displaySet);

        // Autoplay datasets that have framerates set
        if (multiframeMetadata && multiframeMetadata.isMultiframeImage && multiframeMetadata.averageFrameRate > 0) {
            playClipController.play();
        }

        // Enable mouse, mouseWheel, touch, and keyboard input on the element
        cornerstoneTools.mouseInput.enable(element);
        cornerstoneTools.touchInput.enable(element);
        cornerstoneTools.mouseWheelInput.enable(element);
        cornerstoneTools.keyboardInput.enable(element);

        // Use the tool manager to enable the currently active tool for this
        // newly rendered element
        const activeTool = toolManager.getActiveTool();
        toolManager.setActiveTool(activeTool, [element]);

        // Define a function to run whenever the Cornerstone viewport is rendered
        // (e.g. following a change of window or zoom)
        const onImageRendered = (event, eventData) => {
            // Attention: Adding OHIF.log.info in this function may decrease the performance
            // since this callback function is called multiple times (eg: when a tool is
            // enabled/disabled -> cornerstone[toolName].tool.enable)

            if (!layoutManager.viewportData[viewportIndex]) {
                OHIF.log.warn(`onImageRendered: LayoutManager has no viewport data for this viewport index?: ${viewportIndex}`);
            }

            // Use Session to trigger reactive updates in the viewportOverlay helper functions
            // This lets the viewport overlay always display correct window / zoom values
            Session.set('CornerstoneImageRendered' + viewportIndex, Random.id());

            // Save the current viewport into the OHIF.viewer.data global variable
            const viewport = cornerstone.getViewport(element);
            layoutManager.viewportData[viewportIndex].viewport = viewport;
            OHIF.viewer.data.loadedSeriesData[viewportIndex].viewport = viewport;

            // Check if it has onImageRendered loadAndCacheImage callback
            if (typeof callbacks.onImageRendered === 'function') {
                callbacks.onImageRendered(event, eventData, viewportIndex, templateData);
            }
        };

        // Attach the onImageRendered callback to the CornerstoneImageRendered event
        $element.off('CornerstoneImageRendered', onImageRendered);
        $element.on('CornerstoneImageRendered', onImageRendered);

        // Set a random value for the Session variable in order to trigger an overlay update
        Session.set('CornerstoneImageRendered' + viewportIndex, Random.id());

        // Define a function to run whenever the Cornerstone viewport changes images
        // (e.g. during scrolling)
        const onNewImage = (event, eventData) => {
            // Attention: Adding OHIF.log.info in this function may decrease the performance
            // since this callback function is called multiple times (eg: when a tool is
            // enabled/disabled -> cornerstone[toolName].tool.enable)

            if (isUpdateMetadataDefined) {
                // Update the metaData for missing fields
                metadataProvider.updateMetadata(eventData.enabledElement.image);
            }

            // Update the templateData with the new imageId
            // This allows the template helpers to update reactively
            templateData.imageId = eventData.enabledElement.image.imageId;
            Session.set('CornerstoneNewImage' + viewportIndex, Random.id());
            layoutManager.viewportData[viewportIndex].imageId = eventData.enabledElement.image.imageId;

            // Get the element and stack data
            const element = event.target;
            const toolData = cornerstoneTools.getToolState(element, 'stack');
            if (!toolData || !toolData.data || !toolData.data.length) {
                return;
            }

            // Update orientation markers in case new slices don't have the same orientation
            // as the first slice
            updateOrientationMarkers(element);

            // If this viewport is displaying a stack of images, save the current image
            // index in the stack to the global OHIF.viewer.data object.
            const stack = cornerstoneTools.getToolState(element, 'stack');
            if (stack && stack.data.length && stack.data[0].imageIds.length > 1) {
                const imageIdIndex = stack.data[0].imageIds.indexOf(templateData.imageId);
                layoutManager.viewportData[viewportIndex].currentImageIdIndex = imageIdIndex;
                OHIF.viewer.data.loadedSeriesData[viewportIndex].currentImageIdIndex = imageIdIndex;
            }

            // Check if it has onNewImage loadAndCacheImage callback
            if (typeof callbacks.onNewImage === 'function') {
                callbacks.onNewImage(event, eventData, viewportIndex, templateData);
            }
        };

        // Attach the onNewImage callback to the CornerstoneNewImage event
        $element.off('CornerstoneNewImage', onNewImage);
        $element.on('CornerstoneNewImage', onNewImage);

        // Set a random value for the Session variable in order to trigger an overlay update
        Session.set('CornerstoneNewImage' + viewportIndex, Random.id());

        const onStackScroll = (e, eventData) => {
            // Attention: Adding OHIF.log.info in this function may decrease the performance
            // since this callback function is called multiple times (eg: when a tool is
            // enabled/disabled -> cornerstone[toolName].tool.enable)

            // Update the imageSlider value
            Session.set('CornerstoneNewImage' + viewportIndex, Random.id());
        };

        $element.off('CornerstoneStackScroll', onStackScroll);
        if (stack.imageIds.length > 1) {
            $element.on('CornerstoneStackScroll', onStackScroll);
        }

        // Define a function to trigger an event whenever a new viewport is being used
        // This is used to update the value of the "active viewport", when the user interacts
        // with a new viewport element
        const sendActivationTrigger = (event, eventData) => {
            // Attention: Adding OHIF.log.info in this function decrease the performance
            // since this callback function is called multiple times (eg: when a tool is
            // enabled/disabled -> cornerstone[toolName].tool.enable)

            // Check if the current active viewport in the Meteor Session
            // Is the same as the viewport in which the activation event was fired.
            // If it was, no changes are necessary, so stop here.
            const element = eventData.element;
            const activeViewportIndex = Session.get('activeViewport');
            const viewportIndex = $('.imageViewerViewport').index(element);

            // Reset the focus, even if we don't need to re-enable reference lines or prefetching
            $(element).focus();

            if (viewportIndex === activeViewportIndex) {
                return;
            }

            OHIF.log.info('imageViewerViewport sendActivationTrigger');

            // Otherwise, trigger an 'OHIFActivateViewport' event to be handled by the Template event
            // handler
            eventData.viewportIndex = viewportIndex;
            const customEvent = $.Event('OHIFActivateViewport', eventData);

            // Need to overwrite the type set in the original event
            customEvent.type = 'OHIFActivateViewport';
            $(event.target).trigger(customEvent, eventData);
        };

        // Attach the sendActivationTrigger function to all of the Cornerstone interaction events
        $element.off(allCornerstoneEvents, sendActivationTrigger);
        $element.on(allCornerstoneEvents, sendActivationTrigger);

        OHIF.viewer.data.loadedSeriesData = layoutManager.viewportData;

        // Check if image plane (orientation / location) data is present for the current image
        const imagePlane = cornerstoneTools.metaData.get('imagePlane', image.imageId);
        if (imagePlane && imagePlane.frameOfReferenceUID) {
            // If it is, add this element to the global synchronizer...
            OHIF.viewer.updateImageSynchronizer.add(element);

            if (OHIF.viewer.refLinesEnabled) {
                // ... and if reference lines are globally enabled, let cornerstoneTools know.
                cornerstoneTools.referenceLines.tool.enable(element, OHIF.viewer.updateImageSynchronizer);
            }

            // If the crosshairs tool is active, update the synchronizer
            // that is used for its synchronized viewport updating.
            // This is necessary if this new image shares a frame of reference
            // with currently displayed images
            if (activeTool === 'crosshairs') {
                updateCrosshairsSynchronizer(imagePlane.frameOfReferenceUID);
            }
        }

        // Set the active viewport based on the Session variable
        // This is done to ensure that the active element has the current
        // focus, so that keyboard events are triggered.
        if (viewportIndex === Session.get('activeViewport')) {
            setActiveViewport(element);
        }

        // Run any renderedCallback that exists in the data context
        if (data.renderedCallback && typeof data.renderedCallback === 'function') {
            data.renderedCallback(element);
        }

        // Update the LayoutManagerUpdated session key
        layoutManager.updateSession();

        // Check if it has after loadAndCacheImage callback
        if (typeof callbacks.after === 'function') {
            OHIF.log.info('imageViewerViewport after callback');
            callbacks.after(image, templateData, element);
        }
    }, error => {
        // If something goes wrong while loading the image, fire the error handler.
        errorLoadingHandler(element, imageId, error);
    });
};

/**
 * This function sets the display set for the study and calls LoadDisplaySetIntoViewport function
 *
 * @param data includes study data
 * @param displaySetInstanceUid Display set information which is loaded in Template
 * @param templateData currentData of Template
 *
 */
const setDisplaySet = (data, displaySetInstanceUid, templateData) => {
    const study = data.study;
    if (!study || !study.displaySets) {
        throw new OHIFError('Study does not exist or has no display sets');
    }

    study.displaySets.every(displaySet => {
        if (displaySet.displaySetInstanceUid === displaySetInstanceUid) {
            data.displaySet = displaySet;
            return false;
        }

        return true;
    });

    // If we didn't find anything, stop here
    if (!data.displaySet) {
        data.displaySet = study.displaySets[0];
        // throw new OHIFError('Display set not found in specified study!');
    }

    // Otherwise, load pass the data object into loadSeriesIntoViewport
    loadDisplaySetIntoViewport(data, templateData);
};

Meteor.startup(() => {
    window.ViewportLoading = window.ViewportLoading || {};
    toolManager.configureLoadProcess();
});

Template.imageViewerViewport.onRendered(function() {
    const templateData = Template.currentData();
    OHIF.log.info('imageViewerViewport onRendered');

    // When the imageViewerViewport template is rendered
    const element = this.find('.imageViewerViewport');
    this.element = element;

    // Display the loading indicator for this element
    $(element).siblings('.imageViewerLoadingIndicator').css('display', 'block');

    // Get the current active viewport index, if this viewport has the same index,
    // add the CSS 'active' class to highlight this viewport.
    const activeViewport = Session.get('activeViewport');

    let { currentImageIdIndex } = templateData;
    const { viewport, studyInstanceUid, seriesInstanceUid, renderedCallback, displaySetInstanceUid } = templateData;

    if (!currentImageIdIndex) {
        currentImageIdIndex = 0;
    }

    // Calls extendData function to provide flexibility between systems
    imageViewerViewportData.extendData(templateData);

    // Create a data object to pass to the series loading function (loadSeriesIntoViewport)
    const data = {
        element,
        viewport,
        currentImageIdIndex,
        displaySetInstanceUid,
        studyInstanceUid,
        seriesInstanceUid,
        renderedCallback,
        activeViewport
    };

    // If no displaySetInstanceUid was supplied, display the drag/drop
    // instructions and then stop here since we don't know what to display in the viewport.
    if (!displaySetInstanceUid) {
        element.classList.add('empty');
        $(element).siblings('.imageViewerLoadingIndicator').css('display', 'none');
        $(element).siblings('.viewportInstructions').show();
        return;
    }

    // @TypeSafeStudies
    const study = OHIF.viewer.Studies.findBy({ studyInstanceUid });

    data.study = study;
    setDisplaySet(data, displaySetInstanceUid, templateData);
});

Template.imageViewerViewport.onDestroyed(function() {
    OHIF.log.info('imageViewerViewport onDestroyed');

    // When a viewport element is being destroyed
    const element = this.find('.imageViewerViewport');
    const $element = $(element);
    if (!element || $element.hasClass('empty') || !$element.find('canvas').length) {
        return;
    }

    // Disable mouse functions
    cornerstoneTools.mouseInput.disable(element);
    cornerstoneTools.touchInput.disable(element);
    cornerstoneTools.mouseWheelInput.disable(element);

    OHIF.viewer.updateImageSynchronizer.remove(element);

    // Clear the stack prefetch data
    let stackPrefetchData = cornerstoneTools.getToolState(element, 'stackPrefetch');
    stackPrefetchData = [];
    cornerstoneTools.stackPrefetch.disable(element);

    // Try to stop any currently playing clips
    // Otherwise the interval will continuously throw errors
    try {
        const enabledElement = cornerstone.getEnabledElement(element);
        if (enabledElement) {
            cornerstoneTools.stopClip(element);
        }
    } catch (error) {
        OHIF.log.warn(error);
    }

    // Trigger custom Destroy Viewport event
    // for compatibility with other systems
    $element.trigger('OHIFDestroyedViewport');

    // Disable the PlayClipController for the current element
    PlayClipManager.getInstance().remove(element);

    // Disable the viewport element with Cornerstone
    // This also triggers the removal of the element from all available
    // synchronizers, such as the one used for reference lines.
    cornerstone.disable(element);
});

Template.imageViewerViewport.events({
    'OHIFActivateViewport .imageViewerViewport'(event) {
        OHIF.log.info('imageViewerViewport OHIFActivateViewport');
        setActiveViewport(event.currentTarget);
    },

    'click .imageViewerViewport'(event) {
        setActiveViewport(event.currentTarget);
    },

    'CornerstoneToolsMouseDoubleClick .imageViewerViewport, CornerstoneToolsDoubleTap .imageViewerViewport'(event) {
        // Get the double clicked viewport index
        const viewportIndex = $('.imageViewerViewport').index(event.currentTarget);

        // Enlarge the double clicked viewport
        const layoutManager = OHIF.viewerbase.layoutManager;
        layoutManager.toggleEnlargement(viewportIndex);

        // Wait for DOM re-rendering and update the active viewport
        Tracker.afterFlush(() => {
            let viewportIndexToZoom;
            // Check if the viewer is zoomed
            if (layoutManager.isZoomed) {
                // Set the active viewport as the only one visible
                viewportIndexToZoom = 0;
            } else {
                // Set the active viewport as the previous zoomed viewport
                viewportIndexToZoom = layoutManager.zoomedViewportIndex || 0;
            }
            // Set zoomed viewport as active...
            const element = $('.imageViewerViewport').get(viewportIndexToZoom);
            setActiveViewport(element);
        });
    }
});
